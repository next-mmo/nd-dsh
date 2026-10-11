/**
 * ND-maintained proving packages go through the same manifest validation,
 * snapshot, activation, and invocation path as third-party packages. Daily
 * Essentials proves personal daily use, Wallpaper Manager proves a governed
 * native OS capability, and Project Workflow proves project-scoped use.
 */

import { ND_EXTENSION_API_VERSION, ND_EXTENSION_PROTOCOL, type NdExtensionManifest } from './extension-package.js'

export const DAILY_ESSENTIALS_ID = 'nd.daily-essentials'
export const PROJECT_WORKFLOW_ID = 'nd.project-workflow'
export const WALLPAPER_MANAGER_ID = 'nd.wallpaper-manager'

export const DAILY_ESSENTIALS_MANIFEST: NdExtensionManifest = {
  protocol: ND_EXTENSION_PROTOCOL,
  id: DAILY_ESSENTIALS_ID,
  name: 'Daily Essentials',
  description: 'Notes, screen capture, web, and app actions for everyday use — in any context, including Personal with no company yet.',
  version: '1.0.0',
  apiVersion: ND_EXTENSION_API_VERSION,
  contexts: ['personal', 'company', 'project'],
  permissions: [
    'notes.read',
    'notes.write',
    'capture.screen',
    'capture.area',
    'capture.read',
    'clipboard.read',
    'browser.navigate',
    'browser.openExternal',
    'os.launch',
    'chat.start',
  ],
  settings: [
    {
      key: 'searchPrefix',
      title: 'Web search prefix',
      type: 'string',
      default: 'https://www.google.com/search?q=',
      description: 'Where “Search the web” sends the query. Personal and company contexts may override this default.',
    },
  ],
  contributions: {
    tools: [],
    skills: [],
    commands: [
      { id: 'quick-note', title: 'Quick note', host: 'note.create', contexts: ['personal', 'company', 'project'], keywords: ['note', 'memo', 'remember'] },
      { id: 'search-notes', title: 'Search notes', host: 'note.search', contexts: ['personal', 'company', 'project'], keywords: ['note', 'find', 'search'] },
      { id: 'capture-area', title: 'Capture area', host: 'capture.area', contexts: ['personal', 'company', 'project'], keywords: ['screenshot', 'region', 'crop'] },
      { id: 'capture-screen', title: 'Capture screen', host: 'capture.screen', contexts: ['personal', 'company', 'project'], keywords: ['screenshot', 'display', 'monitor'] },
      { id: 'capture-clipboard', title: 'Capture clipboard', host: 'clipboard.read', contexts: ['personal', 'company', 'project'], keywords: ['paste', 'clipboard', 'copy'] },
      { id: 'open-google', title: 'Open Google', host: 'browser.openUrl', contexts: ['personal', 'company', 'project'], keywords: ['google', 'web', 'browser'] },
      { id: 'search-web', title: 'Search the web', host: 'browser.search', contexts: ['personal', 'company', 'project'], keywords: ['google', 'search', 'web'] },
      { id: 'open-website', title: 'Open website', host: 'browser.openUrl', contexts: ['personal', 'company', 'project'], keywords: ['url', 'link', 'website'] },
      { id: 'open-externally', title: 'Open in system browser', host: 'browser.openExternal', contexts: ['personal', 'company', 'project'], keywords: ['external', 'browser', 'url'] },
      { id: 'open-target', title: 'Open app, file, or folder', host: 'os.openTarget', contexts: ['personal', 'company', 'project'], keywords: ['launch', 'app', 'file', 'folder', 'open'] },
      { id: 'ask-nd', title: 'Ask ND', host: 'chat.ask', startsAgent: true, contexts: ['personal', 'company', 'project'], keywords: ['chat', 'agent', 'question'] },
    ],
    views: [
      {
        id: 'notes',
        title: 'Notes',
        description: 'No notes yet. Type anything into the launcher and choose Quick note.',
        kind: 'list',
        host: 'note.search',
        itemTitleKey: 'title',
        itemBodyKey: 'body',
        contexts: ['personal', 'company', 'project'],
        actions: [
          { id: 'note-open', title: 'Open note', host: 'note.open' },
          { id: 'note-delete', title: 'Delete note', host: 'note.delete' },
        ],
      },
      {
        id: 'captures',
        title: 'Captures',
        description: 'No captures yet. Save one with Capture screen or Capture area.',
        kind: 'list',
        host: 'capture.list',
        itemTitleKey: 'title',
        itemBodyKey: 'detail',
        contexts: ['personal', 'company', 'project'],
        actions: [
          { id: 'capture-copy', title: 'Copy image', host: 'capture.copy' },
          { id: 'capture-export', title: 'Export image', host: 'capture.export' },
        ],
      },
    ],
    workflows: [],
  },
}

export const WALLPAPER_MANAGER_MANIFEST: NdExtensionManifest = {
  protocol: ND_EXTENSION_PROTOCOL,
  id: WALLPAPER_MANAGER_ID,
  name: 'Wallpaper Manager',
  description: 'A native desktop extension that changes the host OS wallpaper through ND’s permission broker, with a Discovery surface for remote image links.',
  version: '1.5.0',
  apiVersion: ND_EXTENSION_API_VERSION,
  contexts: ['personal'],
  permissions: ['os.wallpaper.write'],
  settings: [
    {
      key: 'folder',
      title: 'Wallpaper folder',
      type: 'string',
      default: '',
      description: 'Folder containing wallpapers. If empty, your system Pictures directory is used.',
    },
    {
      key: 'mode',
      title: 'Cycling order',
      type: 'string',
      default: 'random',
      description: 'Cycle order: "random" or "sequential".',
    },
    {
      key: 'intervalMinutes',
      title: 'Auto-rotate timer (minutes)',
      type: 'number',
      default: 0,
      description: 'Change wallpaper automatically every N minutes (0 to disable).',
    },
  ],
  contributions: {
    tools: [],
    skills: [],
    commands: [
      {
        id: 'choose-wallpaper',
        title: 'Choose wallpaper',
        description: 'Pick an image and set it as the desktop wallpaper.',
        host: 'os.wallpaper.chooseAndSet',
        contexts: ['personal'],
        keywords: ['wallpaper', 'desktop', 'background', 'image'],
      },
      {
        id: 'set-wallpaper-folder',
        title: 'Link wallpaper folder',
        description: 'Browse and link a desktop wallpaper folder to your library.',
        host: 'os.wallpaper.folders.add',
        contexts: ['personal'],
        keywords: ['wallpaper', 'folder', 'browse', 'directory', 'background'],
      },
      {
        id: 'previous-wallpaper',
        title: 'Previous wallpaper',
        description: 'Cycle to the previous desktop wallpaper from your folder.',
        host: 'os.wallpaper.previous',
        contexts: ['personal'],
        keywords: ['wallpaper', 'previous', 'prev', 'cycle', 'background'],
      },
      {
        id: 'next-wallpaper',
        title: 'Next wallpaper',
        description: 'Cycle to the next desktop wallpaper from your folder.',
        host: 'os.wallpaper.next',
        contexts: ['personal'],
        keywords: ['wallpaper', 'next', 'cycle', 'background'],
      },
      {
        id: 'random-wallpaper',
        title: 'Random wallpaper',
        description: 'Set a random desktop wallpaper from your folder.',
        host: 'os.wallpaper.random',
        contexts: ['personal'],
        keywords: ['wallpaper', 'random', 'shuffle', 'background'],
      },
      {
        id: 'open-wallpaper-studio',
        title: 'Wallpaper Studio',
        description: 'Open the Wallpaper Studio detail page to browse library, switch wallpapers, and configure auto-rotation.',
        host: 'os.wallpaper.status',
        openViewId: 'wallpaper-studio',
        contexts: ['personal'],
        keywords: ['wallpaper', 'studio', 'gallery', 'auto', 'settings', 'background'],
      },
    ],
    views: [
      {
        id: 'wallpaper-studio',
        title: 'Wallpaper Studio',
        description: 'No wallpapers found in the selected folder. Pick a folder or choose an image file to start.',
        kind: 'detail',
        host: 'os.wallpaper.status',
        itemTitleKey: 'title',
        itemBodyKey: 'detail',
        contexts: ['personal'],
        actions: [
          { id: 'apply', title: 'Set as wallpaper', host: 'os.wallpaper.applySelected' },
          { id: 'prev', title: 'Previous wallpaper', host: 'os.wallpaper.previous' },
          { id: 'next', title: 'Next wallpaper', host: 'os.wallpaper.next' },
          { id: 'random', title: 'Random wallpaper', host: 'os.wallpaper.random' },
          { id: 'choose', title: 'Pick file...', host: 'os.wallpaper.chooseAndSet' },
          { id: 'folders-add', title: 'Link folder...', host: 'os.wallpaper.folders.add' },
          { id: 'folders-remove', title: 'Remove linked folder', host: 'os.wallpaper.folders.remove' },
          { id: 'folders-list', title: 'List linked folders', host: 'os.wallpaper.folders.list' },
          { id: 'play-sources-set', title: 'Choose play sources', host: 'os.wallpaper.playSources.set' },
          { id: 'preview', title: 'Preview image', host: 'os.wallpaper.preview' },
          // Data fetch for the grid, not a user-facing button: the library view
          // asks for thumbnails for the rows currently on screen.
          { id: 'thumbnails', title: 'Render thumbnails', host: 'os.wallpaper.thumbnails' },
          // Discovery surface: remote image links (user-saved plus the read-only
          // ND-curated bundle). Same pattern as the library rows above.
          { id: 'links-list', title: 'List wallpaper links', host: 'os.wallpaper.links.list' },
          { id: 'links-add', title: 'Add wallpaper link', host: 'os.wallpaper.links.add' },
          { id: 'links-remove', title: 'Remove wallpaper link', host: 'os.wallpaper.links.remove' },
          { id: 'links-apply', title: 'Set linked wallpaper', host: 'os.wallpaper.links.apply' },
          { id: 'links-save', title: 'Save link to My links', host: 'os.wallpaper.links.save' },
          { id: 'links-next', title: 'Next saved link', host: 'os.wallpaper.links.next' },
          { id: 'links-random', title: 'Random saved link', host: 'os.wallpaper.links.random' },
          // Collections: named, playable sets mixing links and folder images.
          // Thumbnails is a data fetch for the grid, not a user-facing button.
          { id: 'collections-list', title: 'List collections', host: 'os.wallpaper.collections.list' },
          { id: 'collections-create', title: 'Create collection', host: 'os.wallpaper.collections.create' },
          { id: 'collections-delete', title: 'Delete collection', host: 'os.wallpaper.collections.delete' },
          { id: 'collections-add', title: 'Save to collections', host: 'os.wallpaper.collections.add' },
          { id: 'collections-remove', title: 'Remove from collection', host: 'os.wallpaper.collections.removeEntry' },
          { id: 'collections-apply', title: 'Set collection image', host: 'os.wallpaper.collections.apply' },
          { id: 'collections-next', title: 'Next in collection', host: 'os.wallpaper.collections.next' },
          { id: 'collections-random', title: 'Random from collection', host: 'os.wallpaper.collections.random' },
          { id: 'collections-rotate', title: 'Auto-rotate collection', host: 'os.wallpaper.collections.rotate' },
          { id: 'collections-preview', title: 'Preview collection image', host: 'os.wallpaper.collections.preview' },
          { id: 'collections-thumbnails', title: 'Render collection thumbnails', host: 'os.wallpaper.collections.thumbnails' },
          { id: 'links-preview', title: 'Preview linked image', host: 'os.wallpaper.links.preview' },
          { id: 'links-thumbnails', title: 'Render linked thumbnails', host: 'os.wallpaper.links.thumbnails' },
          { id: 'links-import', title: 'Import wallpaper links', host: 'os.wallpaper.links.import' },
          { id: 'links-export', title: 'Export wallpaper links', host: 'os.wallpaper.links.export' },
          // Dev-only curation of the shipped ND bundle; packaged builds refuse.
          { id: 'bundle-add', title: 'Add ND bundle link', host: 'os.wallpaper.bundle.add' },
          { id: 'bundle-update', title: 'Edit ND bundle link', host: 'os.wallpaper.bundle.update' },
          { id: 'bundle-remove', title: 'Remove ND bundle link', host: 'os.wallpaper.bundle.remove' },
        ],
      },
    ],
    workflows: [],
  },
}

export const PROJECT_WORKFLOW_MANIFEST: NdExtensionManifest = {
  protocol: ND_EXTENSION_PROTOCOL,
  id: PROJECT_WORKFLOW_ID,
  name: 'Project Workflow',
  description: 'Read-only view of the project’s repository task board, using the project’s existing workflow integration binding.',
  version: '1.0.0',
  apiVersion: ND_EXTENSION_API_VERSION,
  contexts: ['project'],
  permissions: ['workflow.read'],
  settings: [],
  contributions: {
    tools: [],
    skills: [],
    commands: [],
    views: [
      {
        id: 'repository-tasks',
        title: 'Repository tasks',
        description: 'No repository tasks were found for this project yet.',
        kind: 'list',
        host: 'workflow.list',
        itemTitleKey: 'title',
        itemBodyKey: 'detail',
        contexts: ['project'],
        actions: [],
      },
    ],
    workflows: [
      {
        id: 'workflow-mirror',
        title: 'Repository tasks (open board)',
        description: 'Refresh and open the read-only repository task board for this project.',
        pluginId: 'auto',
        contexts: ['project'],
      },
    ],
  },
}

export const BUILTIN_EXTENSION_PACKAGES: readonly NdExtensionManifest[] = [
  DAILY_ESSENTIALS_MANIFEST,
  WALLPAPER_MANAGER_MANIFEST,
  PROJECT_WORKFLOW_MANIFEST,
]

/**
 * Built-in packages activate in Personal by default so daily essentials work
 * before any company or project exists. Every other context — including any
 * company/project use of Daily Essentials — still requires explicit activation.
 */
export function defaultActivationContexts(manifest: NdExtensionManifest): readonly ('personal' | 'company' | 'project')[] {
  return manifest.contexts.includes('personal') ? ['personal'] : []
}
