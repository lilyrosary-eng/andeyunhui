// 手工起草占位骨架（详见 gen/android/README.md）。
// 结构与 Tauri v2 `tauri android init` 生成的对齐；完整工程由 `tauri android init` 生成。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FailOnProjectRepos)
    repositories {
        google()
        mavenCentral()
    }
}

include(":app")
