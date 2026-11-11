; 安得云荟 NSIS 安装钩子
;
; 职责三件事：
;   1. 安装/注销 Windows 静默更新助手（SYSTEM 计划任务 + Program Files 下的 helper）。
;   2. 卸载时阻止"删除应用数据"跟随 AppData junction 清空真实数据目录。
;   3. 撤销 Tauri fileAssociations 写的「抢占默认程序」，改成只登记「打开方式」。
;
; 注意：helper 必须放在 Program Files 的受保护目录，不能放 $INSTDIR——
; 本项目的安装目录可能被用户设在可写盘（例如 D:\安得云荟），普通用户可写，
; 放那里等于给本地用户一个 SYSTEM 提权入口。

!define ANDEYUNHUI_HELPER_DIR "$PROGRAMFILES64\AndeYunhuiUpdater"

; ============ 文件关联：只进「打开方式」，不抢默认 ============
;
; Tauri 的 `fileAssociations` 用 `!insertmacro APP_ASSOCIATE` 注册每个扩展名，
; 而 APP_ASSOCIATE 做的是**完整抢占**：把 `.ext` 的默认值写成我们的 ProgID。
; 本项目 `installMode = "perMachine"` ⇒ SHCTX = HKLM ⇒ 影响**全机器所有用户**：
; png / jpg / mp4 / mp3 / txt / docx… 的默认程序被改成安得云荟，
; 文件图标与资源管理器「类型」列一起变成"用安得云荟·玉兰打开视频"。
;
; 用户真正想要的只是右键「打开方式」里能选到我们。所以安装末尾把默认值撤掉，
; 改写成 `OpenWithProgids` —— 只登记"这个程序也能打开它"，不动默认程序、不动图标。
;
; ⚠ 下面的扩展名清单必须与 `tauri.conf.json` 的 `fileAssociations` 保持一致。
;   两边漂移的症状是"打开方式里少了某个类型"，不会报错，所以改一处要改两处。
;   （2026-11-10：image 7 / video 6 / audio 6 / document 8）
!macro ANDEYUNHUI_ASSOC_AS_OPENWITH PROGID EXT
  DeleteRegValue SHCTX ".${EXT}" ""
  WriteRegStr SHCTX ".${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

!macro ANDEYUNHUI_ASSOC_DROP_OPENWITH PROGID EXT
  DeleteRegValue SHCTX ".${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro ANDEYUNHUI_ASSOC_FIX_ALL
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "png"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "jpg"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "jpeg"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "gif"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "webp"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "bmp"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "image" "tiff"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "video" "mp4"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "video" "mkv"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "video" "mov"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "video" "avi"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "video" "webm"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "video" "flv"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "audio" "mp3"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "audio" "flac"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "audio" "wav"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "audio" "ogg"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "audio" "m4a"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "audio" "aac"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "pdf"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "epub"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "txt"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "md"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "docx"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "pptx"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "xlsx"
  !insertmacro ANDEYUNHUI_ASSOC_AS_OPENWITH "document" "csv"
!macroend

!macro ANDEYUNHUI_ASSOC_CLEAN_ALL
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "png"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "jpg"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "jpeg"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "gif"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "webp"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "bmp"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "image" "tiff"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "video" "mp4"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "video" "mkv"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "video" "mov"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "video" "avi"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "video" "webm"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "video" "flv"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "audio" "mp3"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "audio" "flac"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "audio" "wav"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "audio" "ogg"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "audio" "m4a"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "audio" "aac"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "pdf"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "epub"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "txt"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "md"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "docx"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "pptx"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "xlsx"
  !insertmacro ANDEYUNHUI_ASSOC_DROP_OPENWITH "document" "csv"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 主安装段已经把 binaries/andeyunhui-updater.exe 放到 $INSTDIR\binaries。
  CreateDirectory "${ANDEYUNHUI_HELPER_DIR}"
  CopyFiles /SILENT "$INSTDIR\binaries\andeyunhui-updater.exe" "${ANDEYUNHUI_HELPER_DIR}\andeyunhui-updater-${VERSION}.exe"
  ; helper 自己会收紧 ProgramData 目录 ACL 并注册 SYSTEM 计划任务。
  ExecWait '"${ANDEYUNHUI_HELPER_DIR}\andeyunhui-updater-${VERSION}.exe" --install-task' $0
  DetailPrint "更新助手安装退出码: $0"

  ; Tauri 的 APP_ASSOCIATE 已在上面的安装段里抢了默认程序，这里逐个撤回来。
  ; 幂等：重复安装不会累积副作用。
  SetShellVarContext all
  !insertmacro ANDEYUNHUI_ASSOC_FIX_ALL
  DetailPrint "文件关联已改为「仅登记打开方式」，未修改系统默认程序"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 不允许卸载器的"删除应用数据"跟随 junction 删除用户真实数据。
  StrCpy $DeleteAppDataCheckboxState 0

  IfFileExists "${ANDEYUNHUI_HELPER_DIR}\andeyunhui-updater-${VERSION}.exe" 0 +3
    ExecWait '"${ANDEYUNHUI_HELPER_DIR}\andeyunhui-updater-${VERSION}.exe" --uninstall-task' $0
    DetailPrint "更新助手注销退出码: $0"

  RMDir /r "${ANDEYUNHUI_HELPER_DIR}"

  ; Tauri 的 APP_UNASSOCIATE 会删 ProgID 与 `.ext` 默认值，但不一定清
  ; OpenWithProgids；留着会在"打开方式"里留下一个指向已卸载程序的死条目。
  SetShellVarContext all
  !insertmacro ANDEYUNHUI_ASSOC_CLEAN_ALL
!macroend

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
