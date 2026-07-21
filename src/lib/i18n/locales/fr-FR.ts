// Français
export const frFR: Record<string, string> = {
  // Commun
  'common.loading': 'Chargement...',
  'common.confirm': 'OK',
  'common.cancel': 'Annuler',
  'common.open': 'Ouvrir',
  'common.close': 'Fermer',
  'common.delete': 'Supprimer',
  'common.restore': 'Restaurer',

  // Barre de titre
  'titlebar.minimize': 'Réduire',
  'titlebar.maximize': 'Agrandir',
  'titlebar.close': 'Fermer',

  // Navigation principale
  'nav.notes': 'Andeyunhui',
  'nav.extensions': 'Extensions',
  'nav.transfer': 'Station de transfert',
  'nav.settings': 'Paramètres',

  // Barre latérale
  'sidebar.niaoluo': 'Extensions',
  'sidebar.searchExt': 'Rechercher des extensions...',
  'sidebar.noExtInstalled': 'Aucune extension installée',
  'sidebar.noExtMatch': 'Aucune extension correspondante',
  'sidebar.backToList': 'Retour à la liste des extensions',
  'sidebar.manageExtSettings': 'Gérer les paramètres des extensions',
  'sidebar.moduleSettings': 'Paramètres du module',
  'sidebar.back': 'Retour',

  // Paramètres - Onglets
  'settings.tab.general': 'Général',
  'settings.tab.themes': 'Thème',
  'settings.tab.extensions': 'Extensions',
  'settings.tab.transfer': 'Transfert',
  'settings.tab.model': 'Modèle',
  'settings.tab.blacklist': 'Liste noire',
  'settings.tab.about': 'À propos',

  // Paramètres - Général - Zoom
  'settings.general.zoom.title': 'Zoom',
  'settings.general.zoom.level': 'Niveau de zoom de l\'interface',

  // Paramètres - Général - Langue
  'settings.general.language.title': 'Langue',
  'settings.general.language.label': 'Langue de l\'interface',
  'settings.general.language.desc': 'Choisissez la langue d\'affichage de l\'application ; prend effet immédiatement',

  // Paramètres - Général - Raccourcis
  'settings.general.shortcuts.title': 'Raccourcis clavier',
  'settings.general.shortcuts.resetDefault': 'Réinitialiser',
  'settings.general.shortcuts.pressKey': 'Appuyez sur une touche...',
  'settings.general.shortcuts.editTip': 'Cliquez pour modifier le raccourci',

  // Raccourcis
  'shortcut.bold': 'Gras',
  'shortcut.italic': 'Italique',
  'shortcut.link': 'Lien',
  'shortcut.screenshot': 'Capture d\'écran globale',
  'shortcut.recorder': 'Enregistrement d\'écran global',
  'shortcut.clipboard': 'Widget presse-papiers',
  'shortcut.dropzone': 'Widget station de transfert',

  // Paramètres - Général - Général
  'settings.general.common.title': 'Général',
  'settings.general.tray.title': 'Réduire dans la barre d\'état',
  'settings.general.tray.desc': 'Masquer dans la barre d\'état système au lieu de quitter lors de la fermeture de la fenêtre',
  'settings.general.autosave.title': 'Enregistrement automatique',
  'settings.general.autosave.desc': 'Sauvegarde automatiquement le fichier original dans la station de transfert lors de changements',
  'settings.general.autosave.interval': 'Intervalle d\'enregistrement (secondes)',

  // Paramètres - Thème
  'settings.themes.appearance': 'Apparence',
  'settings.theme.system': 'Suivre le système',
  'settings.theme.light': 'Clair',
  'settings.theme.dark': 'Sombre',
  'settings.themes.nativeConfig': 'Thème natif',
  'settings.themes.themeColor': 'Couleur du thème',
  'settings.themes.elementColor': 'Couleur des éléments',
  'settings.themes.followSystem': 'Suivre le système',
  'settings.themes.cn': 'ZH',
  'settings.themes.packConfig': 'Pack de thème',
  'settings.themes.selectPack': 'Choisir un pack de thème',
  'settings.themes.reverseColor': 'Inverser les couleurs des éléments',
  'settings.themes.customBg': 'Arrière-plan personnalisé',
  'settings.themes.selectImage': 'Choisir une image',
  'settings.themes.display': 'Paramètres d\'affichage',
  'settings.themes.bodyFont': 'Police du texte',
  'settings.themes.searchFont': 'Rechercher des polices...',
  'settings.themes.systemDefault': 'Système par défaut',
  'settings.themes.detectingFonts': 'Détection des polices système...',
  'settings.themes.noFont': 'Aucune police correspondante',
  'settings.themes.panelOpacity': 'Opacité du panneau',

  // Noms de couleur
  'color.default': 'Par défaut',
  'color.green': 'Vert classique',
  'color.blue': 'Bleu classique',
  'color.purple': 'Violet',
  'color.orange': 'Orange',

  // Paramètres - Transfert
  'settings.transfer.archiveTitle': 'Archive (notes / fichiers / images)',
  'settings.transfer.archiveDesc': 'Toute modification laisse un instantané ici, restorable à tout moment',
  'settings.transfer.noArchive': 'Aucune archive',
  'settings.transfer.noArchiveDesc': 'Les instantanés sont générés automatiquement après modification ou import de contenu',
  'settings.transfer.snapshotCount': '{count} instantanés au total',
  'settings.transfer.clearArchive': 'Vider l\'archive',
  'settings.transfer.confirmClear': 'Vider tous les instantanés d\'archive ? Cette action est irréversible.',
  'settings.transfer.restore': 'Restaurer',
  'settings.transfer.delete': 'Supprimer',
  'settings.transfer.restored': 'Restauré : {name}',
  'settings.transfer.restoreFailed': 'Échec de la restauration : {err}',
  'settings.transfer.confirmDelete': 'Supprimer l\'archive \'{name}\' ?',

  // Types d'archive
  'kind.note': 'Note',
  'kind.image': 'Image',
  'kind.file': 'Fichier',

  // Paramètres - À propos
  'settings.about.title': 'À propos du logiciel',
  'settings.about.version': 'Version : {v}',
  'settings.about.author': 'Auteur : Rosary · Merci de votre utilisation',
  'settings.about.previewBoot': 'Aperçu de l\'écran de démarrage',
  'settings.about.previewDesc': 'Sélectionnez un thème pour prévisualiser l\'animation de démarrage en plein écran',
  'settings.about.githubRelease': 'Aller à la page GitHub des versions',
  'settings.about.checkUpdate': 'Vérifier les mises à jour',
  'settings.about.officialRelease': 'Aller à la page des versions Andeyunhui',
  'settings.about.open': 'Ouvrir',
  'settings.about.dataBackup': 'Sauvegarde des données',
  'settings.about.exportBackup': 'Exporter la sauvegarde',
  'settings.about.backupName': 'Sauvegarde',
  'settings.about.exportSuccess': 'Sauvegarde exportée avec succès !',
  'settings.about.exportFailed': 'Échec de l\'exportation, veuillez réessayer',
  'settings.about.errorLog': 'Journal d\'erreurs',
  'settings.about.errorLogDesc': 'Ouvre le dossier des journaux ; vous pouvez envoyer les fichiers de log au développeur pour le dépannage',
  'settings.about.openFolder': 'Ouvrir le dossier',
};
