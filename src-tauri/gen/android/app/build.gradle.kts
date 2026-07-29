// 手工起草占位骨架（详见 gen/android/README.md）。
// 关键决策：minSdk = 26（用户拍板 Android v1 下限，对应 API 8.0 Oreo）；
// compileSdk / targetSdk = 34（合理的中位值，可由后续 `tauri android init` 调整）。
plugins {
    id("com.android.application")
    kotlin("android")
    id("app.tauri.tauri_plugin")
}

val tauriPlugins = listOf(
    "app.tauri.core",
    "app.tauri.plugin.app",
    "app.tauri.plugin.notification",
    "app.tauri.plugin.webview-event",
)

tauriPlugins.forEach {
    implementation(project(":plugins:$it"))
}

android {
    compileSdk = 34
    namespace = "com.rosary.andengyuanhua"

    defaultConfig {
        applicationId = "com.rosary.andengyuanhua"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "2.3.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            isMinifyEnabled = false
            isDebuggable = true
        }
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.webkit:webkit:1.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
