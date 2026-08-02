; 安得云荟 NSIS 安装钩子（可选启用）
; 在 tauri.conf.json 的 bundle.windows.nsis 增加 "installerHooks": "scripts/installer-hooks.nsh" 即可启用。
;
; 说明：Tauri v2 的 installerHooks 仅支持"扩展安装步骤"的钩子宏（官方不推荐插入独立选目录页面）。
; 本文件演示在 PREINSTALL 阶段用 nsDialogs 弹出一个"选择数据存放目录"页，并把选择写入
; 安装目录下的 andeyunhui.dataroot.json（seed 文件）。应用首次启动时会读取该 seed 作为初始数据根。
;
; 注意：nsDialogs 自定义页面在 hooks 宏内属于社区用法，需在真实打包环境验证；若 build 报错，
; 请从 tauri.conf.json 移除 installerHooks 字段，改用应用内"首次运行引导"（设置面板数据存放位置）。

!include "nsDialogs.nsh"
!include "FileFunc.nsh"

Var DataDirPage
Var DataDirEdit
Var DataDirState ; 是否已由本钩子设置过（避免重复）

; 默认数据目录（与 Tauri app_data_dir 同级即可，用户可改）
Function .onInit
  StrCpy $DataDirState "0"
FunctionEnd

; PREINSTALL：在文件复制前弹出目录选择页
!macro NSIS_HOOK_PREINSTALL
  ${If} $DataDirState == "0"
    nsDialogs::Create 1018
    Pop $DataDirPage
    ${If} $DataDirPage == error
      Goto preinstall_done
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 12u "请选择安得云荟的数据存放目录（笔记、插件、缓存等将保存在此）："
    Pop $0

    ${NSD_CreateText} 0 14u 80% 12u "$LOCALAPPDATA\com.rosary.andengyuanhua"
    Pop $DataDirEdit

    ${NSD_CreateButton} 82% 14u 18% 12u "浏览"
    Pop $1
    ${NSD_OnClick} $1 pickDataDir

    nsDialogs::Show
    ${If} $DataDirState == "1"
      ; 用户已选择，写入 seed 文件
      FileOpen $2 "$INSTDIR\andeyunhui.dataroot.json" "w"
      FileWrite $2 '{ "data_root": "'
      FileWrite $2 $DataDirEdit
      FileWrite $2 '" }'
      FileClose $2
    ${EndIf}
    preinstall_done:
  ${EndIf}
!macroend

Function pickDataDir
  nsDialogs::SelectFolderDialog "选择数据存放目录" "$LOCALAPPDATA"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $DataDirEdit $0
    StrCpy $DataDirState "1"
  ${EndIf}
FunctionEnd

; POSTINSTALL：兜底，若 PREINSTALL 未写 seed，则按默认不写（应用会用默认 app_data）
!macro NSIS_HOOK_POSTINSTALL
!macroend
!macro NSIS_HOOK_PREUNINSTALL
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
