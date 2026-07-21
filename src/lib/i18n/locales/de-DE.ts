// Deutsch
export const deDE: Record<string, string> = {
  // Allgemein
  'common.loading': 'Wird geladen...',
  'common.confirm': 'OK',
  'common.cancel': 'Abbrechen',
  'common.open': 'Öffnen',
  'common.close': 'Schließen',
  'common.delete': 'Löschen',
  'common.restore': 'Wiederherstellen',

  // Titelleiste
  'titlebar.minimize': 'Minimieren',
  'titlebar.maximize': 'Maximieren',
  'titlebar.close': 'Schließen',

  // Hauptnavigation
  'nav.notes': 'Andeyunhui',
  'nav.extensions': 'Erweiterungen',
  'nav.transfer': 'Transferstation',
  'nav.settings': 'Einstellungen',

  // Seitenleiste
  'sidebar.niaoluo': 'Erweiterungen',
  'sidebar.searchExt': 'Erweiterungen suchen...',
  'sidebar.noExtInstalled': 'Keine Erweiterungen installiert',
  'sidebar.noExtMatch': 'Keine passenden Erweiterungen',
  'sidebar.backToList': 'Zurück zur Erweiterungsliste',
  'sidebar.manageExtSettings': 'Erweiterungseinstellungen verwalten',
  'sidebar.moduleSettings': 'Moduleinstellungen',
  'sidebar.back': 'Zurück',

  // Einstellungen - Tabs
  'settings.tab.general': 'Allgemein',
  'settings.tab.themes': 'Design',
  'settings.tab.extensions': 'Erweiterungen',
  'settings.tab.transfer': 'Transfer',
  'settings.tab.model': 'Modell',
  'settings.tab.blacklist': 'Blockliste',
  'settings.tab.about': 'Über',

  // Einstellungen - Allgemein - Zoom
  'settings.general.zoom.title': 'Zoom',
  'settings.general.zoom.level': 'UI-Zoomstufe',

  // Einstellungen - Allgemein - Sprache
  'settings.general.language.title': 'Sprache',
  'settings.general.language.label': 'Oberflächensprache',
  'settings.general.language.desc': 'Wählen Sie die Anzeigesprache der App; wird sofort übernommen',

  // Einstellungen - Allgemein - Tastenkürzel
  'settings.general.shortcuts.title': 'Tastenkürzel',
  'settings.general.shortcuts.resetDefault': 'Auf Standard zurücksetzen',
  'settings.general.shortcuts.pressKey': 'Taste drücken...',
  'settings.general.shortcuts.editTip': 'Zum Bearbeiten des Kürzels klicken',

  // Tastenkürzel
  'shortcut.bold': 'Fett',
  'shortcut.italic': 'Kursiv',
  'shortcut.link': 'Link',
  'shortcut.screenshot': 'Globale Bildschirmaufnahme',
  'shortcut.recorder': 'Globale Bildschirmaufzeichnung',
  'shortcut.clipboard': 'Zwischenablage-Widget',
  'shortcut.dropzone': 'Transferstation-Widget',

  // Einstellungen - Allgemein - Allgemein
  'settings.general.common.title': 'Allgemein',
  'settings.general.tray.title': 'In Tray minimieren',
  'settings.general.tray.desc': 'Beim Schließen des Fensters in die Systemablage ausblenden statt zu beenden',
  'settings.general.autosave.title': 'Automatisch speichern',
  'settings.general.autosave.desc': 'Erkennt Änderungen und sichert die Originaldatei automatisch in der Transferstation',
  'settings.general.autosave.interval': 'Speicherintervall (Sekunden)',

  // Einstellungen - Design
  'settings.themes.appearance': 'Erscheinungsbild',
  'settings.theme.system': 'System folgen',
  'settings.theme.light': 'Hell',
  'settings.theme.dark': 'Dunkel',
  'settings.themes.nativeConfig': 'Nativdesign',
  'settings.themes.themeColor': 'Designfarbe',
  'settings.themes.elementColor': 'Elementfarbe',
  'settings.themes.followSystem': 'System folgen',
  'settings.themes.cn': 'ZH',
  'settings.themes.packConfig': 'Designpaket',
  'settings.themes.selectPack': 'Designpaket auswählen',
  'settings.themes.reverseColor': 'Elementfarben umkehren',
  'settings.themes.customBg': 'Benutzerdefinierter Hintergrund',
  'settings.themes.selectImage': 'Bild auswählen',
  'settings.themes.display': 'Anzeigeeinstellungen',
  'settings.themes.bodyFont': 'Textschriftart',
  'settings.themes.searchFont': 'Schriftarten suchen...',
  'settings.themes.systemDefault': 'Systemstandard',
  'settings.themes.detectingFonts': 'Systemschriftarten werden erkannt...',
  'settings.themes.noFont': 'Keine passende Schriftart',
  'settings.themes.panelOpacity': 'Panel-Deckkraft',

  // Farbnamen
  'color.default': 'Standard',
  'color.green': 'Klassisch Grün',
  'color.blue': 'Klassisch Blau',
  'color.purple': 'Lila',
  'color.orange': 'Orange',

  // Einstellungen - Transfer
  'settings.transfer.archiveTitle': 'Archiv (Notizen / Dateien / Bilder)',
  'settings.transfer.archiveDesc': 'Jede Änderung hinterlässt hier einen Schnappschuss und kann jederzeit wiederhergestellt werden',
  'settings.transfer.noArchive': 'Noch keine Archive',
  'settings.transfer.noArchiveDesc': 'Schnappschüsse werden nach dem Bearbeiten oder Importieren von Inhalten automatisch erstellt',
  'settings.transfer.snapshotCount': 'Insgesamt {count} Schnappschüsse',
  'settings.transfer.clearArchive': 'Archiv leeren',
  'settings.transfer.confirmClear': 'Alle Archiv-Schnappschüsse löschen? Dies kann nicht rückgängig gemacht werden.',
  'settings.transfer.restore': 'Wiederherstellen',
  'settings.transfer.delete': 'Löschen',
  'settings.transfer.restored': 'Wiederhergestellt: {name}',
  'settings.transfer.restoreFailed': 'Wiederherstellung fehlgeschlagen: {err}',
  'settings.transfer.confirmDelete': 'Archiv \'{name}\' löschen?',

  // Archivtypen
  'kind.note': 'Notiz',
  'kind.image': 'Bild',
  'kind.file': 'Datei',

  // Einstellungen - Über
  'settings.about.title': 'Über die Software',
  'settings.about.version': 'Version: {v}',
  'settings.about.author': 'Autor: Rosary · Danke für die Nutzung',
  'settings.about.previewBoot': 'Startbildschirm Vorschau',
  'settings.about.previewDesc': 'Wählen Sie ein Design, um die Startanimation im Vollbild zu sehen',
  'settings.about.githubRelease': 'Zur GitHub-Release-Seite',
  'settings.about.checkUpdate': 'Nach Updates suchen',
  'settings.about.officialRelease': 'Zur Andeyunhui-Release-Seite',
  'settings.about.open': 'Öffnen',
  'settings.about.dataBackup': 'Datensicherung',
  'settings.about.exportBackup': 'Backup exportieren',
  'settings.about.backupName': 'Backup',
  'settings.about.exportSuccess': 'Backup erfolgreich exportiert!',
  'settings.about.exportFailed': 'Export fehlgeschlagen, bitte erneut versuchen',
  'settings.about.errorLog': 'Fehlerprotokoll',
  'settings.about.errorLogDesc': 'Öffnet den Protokollordner; Sie können Protokolldateien zur Fehlerbehebung an den Entwickler senden',
  'settings.about.openFolder': 'Ordner öffnen',
};
