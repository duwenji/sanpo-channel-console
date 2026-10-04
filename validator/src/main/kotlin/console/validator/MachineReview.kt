package console.validator

import com.example.sanpoguide.prompt.ReviewSamples
import com.example.sanpoguide.station.format.JcaEd25519
import com.example.sanpoguide.station.format.StationCheck
import com.example.sanpoguide.station.format.StationValidator
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** What the console knows about a submission when its files arrive (DM-001 SUBMISSION). */
data class Upload(
    val channelId: String,
    val submissionId: String,
    /** The publisher's account id when they submitted; the package must be signed by it. */
    val accountId: String,
    /** The version last approved for this channel, if any (DM-001 M-5). */
    val latestApprovedVersion: Int?,
)

/** One reason a submission failed, with API-003's code where there is one (API-001 `Validation`). */
data class Finding(val code: String, val detail: String)

sealed interface Outcome {
    data class Passed(
        val version: Int,
        val sha256: String,
        val size: Int,
        val iconSha256: String,
        /** The review samples' prompts as API-001 `SamplePrompts` JSON (API-001 C-1). */
        val samplePrompts: String,
    ) : Outcome

    data class Failed(val findings: List<Finding>, val version: Int?) : Outcome
}

/**
 * The machine review (ADR-001 A-11, API-003 確認の手順 2〜10): station-format's checks, the same the
 * app runs, plus what only the console knows (which channel, which publisher, which version came
 * before) and the icon. Pure: the Lambda reads and writes, this decides.
 */
object MachineReview {
    const val VALIDATOR = "station-format 1.1.0"
    const val MAX_PACKAGE = 2 * 1024 * 1024
    const val MAX_ICON = 100 * 1024
    const val MAX_ICON_SIDE = 256

    fun review(upload: Upload, zip: ByteArray, icon: ByteArray): Outcome {
        val findings = mutableListOf<Finding>()
        var version: Int? = null
        var passed: Outcome.Passed? = null

        if (zip.size > MAX_PACKAGE) {
            findings += Finding("bad_archive", "${zip.size} bytes (max $MAX_PACKAGE)")
        } else {
            when (val result = StationValidator.checkArchive(zip, listedAs = null, verifier = JcaEd25519)) {
                is StationCheck.Rejected -> findings += Finding(result.code.json, result.detail)
                is StationCheck.Ok -> {
                    val manifest = result.station.manifest
                    version = manifest.version
                    if (manifest.id != upload.channelId) findings += Finding("id_mismatch", "channel.json id is ${manifest.id}, not ${upload.channelId}")
                    if (manifest.publisher != upload.accountId) {
                        findings += Finding("publisher_mismatch", "signed for ${manifest.publisher}, the publisher's account is ${upload.accountId}")
                    }
                    upload.latestApprovedVersion?.let { latest ->
                        if (manifest.version <= latest) findings += Finding("version_not_newer", "version ${manifest.version} is not after the approved $latest")
                    }
                    if (findings.isEmpty()) {
                        passed = Outcome.Passed(manifest.version, sha256Hex(zip), zip.size, "", samplePrompts(result))
                    }
                }
            }
        }
        findings += iconFindings(icon)
        return if (findings.isEmpty()) passed!!.copy(iconSha256 = sha256Hex(icon)) else Outcome.Failed(findings.take(100), version)
    }

    /** PNG, at most 256×256, at most 100KB (API-001 申請). */
    fun iconFindings(icon: ByteArray): List<Finding> {
        if (icon.size > MAX_ICON) return listOf(Finding("bad_icon", "${icon.size} bytes (max $MAX_ICON)"))
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        // The first chunk of a PNG is IHDR: width and height, big-endian, at bytes 16 and 20.
        if (icon.size < 24 || !icon.copyOfRange(0, 8).contentEquals(signature) || String(icon, 12, 4, Charsets.US_ASCII) != "IHDR") {
            return listOf(Finding("bad_icon", "not a PNG"))
        }
        fun int(at: Int) = ((icon[at].toInt() and 0xff) shl 24) or ((icon[at + 1].toInt() and 0xff) shl 16) or
            ((icon[at + 2].toInt() and 0xff) shl 8) or (icon[at + 3].toInt() and 0xff)
        val width = int(16)
        val height = int(20)
        return if (width in 1..MAX_ICON_SIDE && height in 1..MAX_ICON_SIDE) emptyList()
        else listOf(Finding("bad_icon", "${width}×$height (max ${MAX_ICON_SIDE}×$MAX_ICON_SIDE)"))
    }

    private fun samplePrompts(ok: StationCheck.Ok): String {
        val scenarios = JSONArray()
        for (s in ReviewSamples.build(ok.station)) {
            scenarios.put(JSONObject().put("id", s.id).put("label", s.label).put("system", s.system).put("user", s.user))
        }
        return JSONObject().put("generatedBy", VALIDATOR).put("scenarios", scenarios).toString()
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
