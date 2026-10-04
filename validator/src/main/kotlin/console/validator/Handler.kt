package console.validator

import com.amazonaws.services.lambda.runtime.Context
import com.amazonaws.services.lambda.runtime.RequestHandler
import com.amazonaws.services.lambda.runtime.events.S3Event
import software.amazon.awssdk.core.sync.RequestBody
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.Put
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
import software.amazon.awssdk.services.dynamodb.model.Update
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.CopyObjectRequest
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import software.amazon.awssdk.services.s3.model.PutObjectRequest
import java.net.URLDecoder
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The machine-review Lambda (ADR-001 A-11): S3 calls it for each file under `intake/`. When both
 * the package and the icon of an `uploading` submission are there, it reviews them and moves the
 * submission on: to `awaiting_review` (with the review samples' prompts stored for the operator),
 * or to `validation_failed` (freeing the channel, the files moved to `archive/`).
 *
 * Both files raise events, possibly at once: the write is conditional on `uploading`, so only one
 * run records an outcome.
 */
class Handler(
    private val s3: S3Client = S3Client.builder().httpClient(UrlConnectionHttpClient.create()).build(),
    private val db: DynamoDbClient = DynamoDbClient.builder().httpClient(UrlConnectionHttpClient.create()).build(),
    private val table: String = env("TABLE_NAME"),
    private val intakeBucket: String = env("INTAKE_BUCKET"),
    private val recordsBucket: String = env("RECORDS_BUCKET"),
    private val clock: () -> Instant = Instant::now,
) : RequestHandler<S3Event, String> {

    override fun handleRequest(event: S3Event, context: Context?): String {
        val results = event.records.map { record ->
            val key = URLDecoder.decode(record.s3.`object`.key, Charsets.UTF_8)
            runCatching { process(key) }.getOrElse { e ->
                context?.logger?.log("failed on $key: ${e.stackTraceToString()}")
                throw e
            }
        }
        return results.joinToString("; ")
    }

    fun process(key: String): String {
        val match = KEY.matchEntire(key) ?: return "skip $key"
        val (channelId, submissionId) = match.destructured
        val sub = getItem("CH#$channelId", "SUB#$submissionId") ?: return "no submission for $key"
        if (sub.str("state") != "uploading") return "already ${sub.str("state")}: $key"
        val zipKey = sub.str("intakeKey") ?: return "no intake key"
        val iconKey = sub.str("iconIntakeKey") ?: return "no icon key"
        // The other file's event will do the work if it isn't here yet.
        val zip = read(zipKey) ?: return "waiting for $zipKey"
        val icon = read(iconKey) ?: return "waiting for $iconKey"

        val channel = getItem("CH#$channelId", "CH")
        val latest = channel?.get("latestApproved")?.m()?.get("version")?.n()?.toInt()
        val upload = Upload(channelId, submissionId, sub.str("accountId").orEmpty(), latest)
        val outcome = MachineReview.review(upload, zip, icon)
        val now = iso(clock())
        return try {
            when (outcome) {
                is Outcome.Passed -> passed(upload, outcome, now)
                is Outcome.Failed -> failed(upload, outcome, now, zipKey, iconKey)
            }
        } catch (e: TransactionCanceledException) {
            "someone else recorded $submissionId"
        }
    }

    private fun passed(upload: Upload, outcome: Outcome.Passed, now: String): String {
        val samplesKey = "samples/${upload.submissionId}/prompts.json"
        s3.putObject(
            PutObjectRequest.builder().bucket(recordsBucket).key(samplesKey).contentType("application/json").build(),
            RequestBody.fromString(outcome.samplePrompts),
        )
        transact(
            update(
                "CH#${upload.channelId}", "SUB#${upload.submissionId}",
                "SET #s = :awaiting, version = :v, sha256 = :sha, #size = :size, iconSha256 = :icon, validation = :val, " +
                    "samplesKey = :samples, submittedAt = :now, updatedAt = :now, rev = rev + :one, GSI2PK = :queue, GSI2SK = :order REMOVE #ttl",
                "#s = :uploading",
                mapOf("#s" to "state", "#size" to "size", "#ttl" to "ttl"),
                mapOf(
                    ":awaiting" to s("awaiting_review"), ":uploading" to s("uploading"), ":v" to n(outcome.version),
                    ":sha" to s(outcome.sha256), ":size" to n(outcome.size), ":icon" to s(outcome.iconSha256),
                    ":val" to validation(true, emptyList(), now), ":samples" to s(samplesKey), ":now" to s(now), ":one" to n(1),
                    ":queue" to s("QUEUE#REVIEW"), ":order" to s("$now#${upload.channelId}"),
                ),
            ),
            audit(now, upload, ok = true),
        )
        return "passed ${upload.submissionId}"
    }

    private fun failed(upload: Upload, outcome: Outcome.Failed, now: String, zipKey: String, iconKey: String): String {
        transact(
            update(
                "CH#${upload.channelId}", "SUB#${upload.submissionId}",
                "SET #s = :failed, validation = :val, decidedAt = :now, updatedAt = :now, rev = rev + :one" +
                    (if (outcome.version != null) ", version = :v" else "") + " REMOVE #ttl",
                "#s = :uploading",
                mapOf("#s" to "state", "#ttl" to "ttl"),
                buildMap {
                    put(":failed", s("validation_failed")); put(":uploading", s("uploading"))
                    put(":val", validation(false, outcome.findings, now)); put(":now", s(now)); put(":one", n(1))
                    outcome.version?.let { put(":v", n(it)) }
                },
            ),
            // The channel is free for the next submission.
            update(
                "CH#${upload.channelId}", "CH",
                "SET updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId",
                "pendingSubmissionId = :sid",
                emptyMap(),
                mapOf(":now" to s(now), ":one" to n(1), ":sid" to s(upload.submissionId)),
            ),
            audit(now, upload, ok = false, codes = outcome.findings.map { it.code }.distinct()),
        )
        for (key in listOf(zipKey, iconKey)) archive(key)
        return "failed ${upload.submissionId}: ${outcome.findings.joinToString { it.code }}"
    }

    // ---- S3 ----

    private fun read(key: String): ByteArray? = try {
        s3.getObjectAsBytes(GetObjectRequest.builder().bucket(intakeBucket).key(key).build()).asByteArray()
    } catch (e: NoSuchKeyException) {
        null
    }

    /** DM-001 M-4: settled packages wait 90 days under archive/. */
    private fun archive(key: String) {
        val target = key.replaceFirst("intake/", "archive/")
        s3.copyObject(CopyObjectRequest.builder().sourceBucket(intakeBucket).sourceKey(key).destinationBucket(intakeBucket).destinationKey(target).build())
        s3.deleteObject(DeleteObjectRequest.builder().bucket(intakeBucket).key(key).build())
    }

    // ---- DynamoDB ----

    private fun getItem(pk: String, sk: String): Map<String, AttributeValue>? =
        db.getItem(GetItemRequest.builder().tableName(table).key(mapOf("PK" to s(pk), "SK" to s(sk))).consistentRead(true).build())
            .item().takeIf { it.isNotEmpty() }

    private fun update(pk: String, sk: String, expression: String, condition: String, names: Map<String, String>, values: Map<String, AttributeValue>) =
        TransactWriteItem.builder().update(
            Update.builder().tableName(table).key(mapOf("PK" to s(pk), "SK" to s(sk)))
                .updateExpression(expression).conditionExpression(condition)
                .apply { if (names.isNotEmpty()) expressionAttributeNames(names) }
                .expressionAttributeValues(values).build(),
        ).build()

    private fun transact(vararg items: TransactWriteItem) {
        db.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(*items).build())
    }

    /** The audit entry, shaped as the console API writes them (api/src/console/deps.ts). */
    private fun audit(now: String, upload: Upload, ok: Boolean, codes: List<String> = emptyList()): TransactWriteItem {
        val eventId = ulid(clock())
        val target = "CH#${upload.channelId}"
        val detail = buildMap {
            put("submissionId", s(upload.submissionId)); put("ok", AttributeValue.fromBool(ok))
            if (codes.isNotEmpty()) put("codes", AttributeValue.fromL(codes.map(::s)))
        }
        return TransactWriteItem.builder().put(
            Put.builder().tableName(table).item(
                mapOf(
                    "PK" to s("AUDIT#${now.substring(0, 7)}"), "SK" to s("$now#$eventId"), "GSI1PK" to s("TARGET#$target"), "GSI1SK" to s(now),
                    "type" to s("audit"), "eventId" to s(eventId), "at" to s(now), "actorSub" to s("machine-review"), "actorRole" to s("system"),
                    "action" to s("submission.validate"), "target" to s(target), "detail" to AttributeValue.fromM(detail),
                ),
            ).build(),
        ).build()
    }

    private fun validation(ok: Boolean, findings: List<Finding>, now: String): AttributeValue = AttributeValue.fromM(
        mapOf(
            "ok" to AttributeValue.fromBool(ok),
            "errors" to AttributeValue.fromL(findings.map { AttributeValue.fromM(mapOf("code" to s(it.code), "detail" to s(it.detail.take(500)))) }),
            "appStage" to n(1),
            "checkedAt" to s(now),
            "validatorVersion" to s(MachineReview.VALIDATOR),
        ),
    )

    companion object {
        private val KEY = Regex("intake/([a-z0-9-]{3,40})/([0-9A-HJKMNP-TV-Z]{26})\\.(zip|png)")
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        private val random = SecureRandom()

        private fun env(name: String) = System.getenv(name) ?: error("$name is not set")

        /** The same form as the console API: UTC, milliseconds, `Z` (DM-001 M-12). */
        fun iso(at: Instant): String = ISO.format(at)

        fun ulid(at: Instant): String {
            var t = at.toEpochMilli()
            val time = CharArray(10)
            for (i in 9 downTo 0) {
                time[i] = CROCKFORD[(t % 32).toInt()]
                t /= 32
            }
            return String(time) + (1..16).map { CROCKFORD[random.nextInt(32)] }.joinToString("")
        }

        private fun s(value: String): AttributeValue = AttributeValue.fromS(value)
        private fun n(value: Int): AttributeValue = AttributeValue.fromN(value.toString())
        private fun Map<String, AttributeValue>.str(name: String): String? = this[name]?.s()
    }
}
