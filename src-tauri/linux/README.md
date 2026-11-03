# Linux .desktop 模板的几条硬约束（2026-11-03 归档）

源文件：`src-tauri/linux/andeyunhui.desktop`（`bundle.linux.deb.desktopTemplate` 指向它）

这几条踩过坑，写在这里而不是留在模板文件里 —— 模板会原样打进 deb 包的
`/usr/share/applications/andeyunhui.desktop`，中文注释会跟着进用户的系统。

1. **Tauri 的 desktop_template 只提供 5 个变量**：`categories / comment / exec / icon / name`，
   **没有 exec_arg**。所以「以安得云荟打开」必需的文件参数 `%U` 只能写死在模板里。
2. **用 `%U` 而不是 `%f`**：`%U` 传 `file://` URI，正好对应 `main.rs` 的
   `is_supported_file_assoc`（已按平台处理前导斜杠：Linux 保留 `/`，Windows 剥掉）。
3. **`MimeType` 也必须写死**：Tauri 的 `bundle.fileAssociations` 在 Linux **不会**生成这一行
   （实测产出的 .desktop 里没有），不补的话右键「打开方式」里根本没有本应用。

另外：`deb.depends` 里不要再手写 `libwebkit2gtk-4.1-0` / `libgtk-3-0` /
`libayatana-appindicator3-1` —— Tauri 打包时**自动加**这三项，写一遍会变成重复条目
（2026-11-02 解包实测：各项出现 2 次）。
