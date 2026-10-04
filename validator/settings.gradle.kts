pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        // station-format, published by SanpoGuide (ADR-001 T-4). Reading GitHub Packages needs a token
        // with read:packages: $GITHUB_TOKEN in CI, or gpr.user / gpr.key in ~/.gradle/gradle.properties.
        // Without one, only a locally published station-format is used (asking without a token fails).
        val gprUser = providers.gradleProperty("gpr.user").orElse(providers.environmentVariable("GITHUB_ACTOR")).orNull
        val gprKey = providers.gradleProperty("gpr.key").orElse(providers.environmentVariable("GITHUB_TOKEN")).orNull
        if (gprUser != null && gprKey != null) {
            maven {
                name = "SanpoGuide"
                url = uri("https://maven.pkg.github.com/duwenji/SanpoGuide")
                credentials {
                    username = gprUser
                    password = gprKey
                }
                content { includeGroup("com.example.sanpoguide") }
            }
        }
        // A station-format built locally (`./gradlew :station-format:publishToMavenLocal` in SanpoGuide).
        mavenLocal { content { includeGroup("com.example.sanpoguide") } }
    }
}

rootProject.name = "validator"
