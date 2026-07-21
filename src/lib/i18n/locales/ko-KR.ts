// 한국어
export const koKR: Record<string, string> = {
  // 공통
  'common.loading': '로딩 중...',
  'common.confirm': '확인',
  'common.cancel': '취소',
  'common.open': '열기',
  'common.close': '닫기',
  'common.delete': '삭제',
  'common.restore': '복원',

  // 타이틀바
  'titlebar.minimize': '최소화',
  'titlebar.maximize': '최대화',
  'titlebar.close': '닫기',

  // 메인 네비게이션
  'nav.notes': 'Andeyunhui',
  'nav.extensions': '확장 기능',
  'nav.transfer': '전송함',
  'nav.settings': '설정',

  // 사이드바
  'sidebar.niaoluo': '확장 기능',
  'sidebar.searchExt': '확장 기능 검색...',
  'sidebar.noExtInstalled': '설치된 확장 기능 없음',
  'sidebar.noExtMatch': '일치하는 확장 기능 없음',
  'sidebar.backToList': '확장 기능 목록으로 돌아가기',
  'sidebar.manageExtSettings': '확장 기능 설정 관리',
  'sidebar.moduleSettings': '모듈 설정',
  'sidebar.back': '돌아가기',

  // 설정 - 탭
  'settings.tab.general': '일반',
  'settings.tab.themes': '테마',
  'settings.tab.extensions': '확장 기능',
  'settings.tab.transfer': '전송',
  'settings.tab.model': '모델',
  'settings.tab.blacklist': '블랙리스트',
  'settings.tab.about': '정보',

  // 설정 - 일반 - 확대/축소
  'settings.general.zoom.title': '확대/축소',
  'settings.general.zoom.level': 'UI 확대/축소 수준',

  // 설정 - 일반 - 언어
  'settings.general.language.title': '언어',
  'settings.general.language.label': '인터페이스 언어',
  'settings.general.language.desc': '앱 인터페이스 표시 언어를 선택하세요. 전환 즉시 적용됩니다.',

  // 설정 - 일반 - 단축키
  'settings.general.shortcuts.title': '키보드 단축키',
  'settings.general.shortcuts.resetDefault': '기본값으로 복원',
  'settings.general.shortcuts.pressKey': '키를 누르세요...',
  'settings.general.shortcuts.editTip': '클릭하여 단축키 수정',

  // 단축키 항목
  'shortcut.bold': '굵게',
  'shortcut.italic': '기울임꼴',
  'shortcut.link': '링크',
  'shortcut.screenshot': '전역 스크린샷',
  'shortcut.recorder': '전역 화면 녹화',
  'shortcut.clipboard': '클립보드 위젯',
  'shortcut.dropzone': '전송함 위젯',

  // 설정 - 일반 - 일반
  'settings.general.common.title': '일반',
  'settings.general.tray.title': '트레이로 최소화',
  'settings.general.tray.desc': '창을 닫을 때 프로그램을 종료하지 않고 시스템 트레이로 숨기기',
  'settings.general.autosave.title': '자동 저장',
  'settings.general.autosave.desc': '변경 사항 감지 시 원본 파일을 자동으로 백업하여 전송함에 저장',
  'settings.general.autosave.interval': '저장 간격(초)',

  // 설정 - 테마
  'settings.themes.appearance': '모양',
  'settings.theme.system': '시스템 따르기',
  'settings.theme.light': '라이트',
  'settings.theme.dark': '다크',
  'settings.themes.nativeConfig': '네이티브 테마',
  'settings.themes.themeColor': '테마 색상',
  'settings.themes.elementColor': '요소 색상',
  'settings.themes.followSystem': '시스템 따르기',
  'settings.themes.cn': '중',
  'settings.themes.packConfig': '테마 팩',
  'settings.themes.selectPack': '테마 팩 선택',
  'settings.themes.reverseColor': '요소 색상 반전',
  'settings.themes.customBg': '사용자 지정 배경',
  'settings.themes.selectImage': '이미지 선택',
  'settings.themes.display': '표시 설정',
  'settings.themes.bodyFont': '본문 글꼴',
  'settings.themes.searchFont': '글꼴 검색...',
  'settings.themes.systemDefault': '시스템 기본값',
  'settings.themes.detectingFonts': '시스템 글꼴 감지 중...',
  'settings.themes.noFont': '일치하는 글꼴 없음',
  'settings.themes.panelOpacity': '패널 투명도',

  // 색상 이름
  'color.default': '기본값',
  'color.green': '클래식 그린',
  'color.blue': '클래식 블루',
  'color.purple': '보라색',
  'color.orange': '주황색',

  // 설정 - 전송
  'settings.transfer.archiveTitle': '아카이브(노트 / 파일 / 이미지)',
  'settings.transfer.archiveDesc': '모든 변경 사항의 스냅샷이 여기에 저장되며 언제든 복원할 수 있습니다',
  'settings.transfer.noArchive': '아카이브 없음',
  'settings.transfer.noArchiveDesc': '콘텐츠를 편집하거나 가져오면 자동으로 스냅샷이 생성됩니다',
  'settings.transfer.snapshotCount': '총 {count}개의 스냅샷',
  'settings.transfer.clearArchive': '아카이브 비우기',
  'settings.transfer.confirmClear': '모든 아카이브 스냅샷을 삭제할까요? 이 작업은 되돌릴 수 없습니다.',
  'settings.transfer.restore': '복원',
  'settings.transfer.delete': '삭제',
  'settings.transfer.restored': '복원됨: {name}',
  'settings.transfer.restoreFailed': '복원 실패: {err}',
  'settings.transfer.confirmDelete': '아카이브 \'{name}\'을(를) 삭제할까요?',

  // 아카이브 종류
  'kind.note': '노트',
  'kind.image': '이미지',
  'kind.file': '파일',

  // 설정 - 정보
  'settings.about.title': '소프트웨어 정보',
  'settings.about.version': '버전: {v}',
  'settings.about.author': '작성자: Rosary · 이용해 주셔서 감사합니다',
  'settings.about.previewBoot': '시작 화면 미리보기',
  'settings.about.previewDesc': '테마를 선택하면 시작 애니메이션을 전체 화면으로 미리 볼 수 있습니다',
  'settings.about.githubRelease': 'GitHub 릴리스 페이지로 이동',
  'settings.about.checkUpdate': '업데이트 확인',
  'settings.about.officialRelease': 'Andeyunhui 릴리스 페이지로 이동',
  'settings.about.open': '열기',
  'settings.about.dataBackup': '데이터 백업',
  'settings.about.exportBackup': '백업 내보내기',
  'settings.about.backupName': '백업',
  'settings.about.exportSuccess': '백업 내보내기 성공!',
  'settings.about.exportFailed': '내보내기 실패, 다시 시도하세요',
  'settings.about.errorLog': '오류 로그',
  'settings.about.errorLogDesc': '로그 폴더를 열고 로그 파일을 개발자에게 제출하여 문제를 해결할 수 있습니다',
  'settings.about.openFolder': '폴더 열기',
};
