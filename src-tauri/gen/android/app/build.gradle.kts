import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    // Android v1 · T01：compileSdk 必须 36（:tauri-android 库 compileSdk=36，app 依赖它需 ≥36，硬性约束）。
    // minSdk = 26（用户拍板 Android v1 下限，对应 API 8.0 Oreo）。
    // targetSdk = 34（用户拍板保守 runtime 行为；34→36 的行为收紧对本应用五模块无负面影响，留后续 T+ 升级）。
    compileSdk = 36
    namespace = "com.rosary.andengyuanhua"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.rosary.andengyuanhua"
        minSdk = 26
        targetSdk = 34
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // Android v1 · T01：ABI 拆分由 RustPlugin（buildSrc）的 productFlavors 机制负责，不在此处用 splits.abi。
    // 原因：RustPlugin 在 apply 时创建 universal/arm64/arm/x86/x86_64 flavors 并设 ndk.abiFilters，
    //   AGP 不允许 splits.abi 与 ndk.abiFilters 同时存在（Conflicting configuration 错误），
    //   且 isUniversalApk=false 会破坏 RustPlugin 依赖的 mergeUniversal{Debug,Release}JniLibFolders task。
    // 体积优化（§9.7.3）改走 RustPlugin 原生开关：
    //   - 临时只产 arm64-v8a：gradle.properties 设 `abiList=arm64-v8a`（限制 universal flavor）；
    //   - 或构建指定 flavor：`gradlew assembleArm64Debug`（单 arm64-v8a APK）。
    // T01 骨架阶段先用默认全 flavor 确保可构建，体积优化留 T+ 按 §9.7.3 落地。
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")