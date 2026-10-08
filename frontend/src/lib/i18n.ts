export type Lang = 'en' | 'ja';

export interface Translations {
  // Controls
  searchPlaceholder: string;
  sortMostViewed: string;
  sortLeastViewed: string;
  sortNewest: string;
  sortOldest: string;
  allGames: string;
  viewCalendar: string;      // calendar tab under the filter bar
  calHide: string;           // the calendar panel's bottom handle
  clearDates: string;
  dateFrom: string;
  dateTo: string;
  // Loading / empty / error
  loading: string;
  noClips: string;
  clearFilters: string;     // empty-state button: clears search, game and date filters
  errorTitle: string;
  errorHint: string;
  renderError: string;
  // Auth / login banner
  loginBtn: string;
  logoutBtn: string;
  refreshBtn: string;
  refreshingBtn: string;
  dismissBanner: string;
  loginBannerWithDate: (date: string) => string;
  loginBannerNoDate: string;
  // Help modal — button + title
  searchHelpBtn: string;        // header help button label / aria-label
  helpTitle: string;            // modal h2: "How to use" / "使い方"
  // Help modal — browsing section
  helpBrowse: string;
  helpBrowseDesc: string;
  // Help modal — layout section
  helpLayout: string;
  helpLayoutDesc: string;
  // Help modal — sort section
  helpSort: string;
  helpSortDesc: string;
  // Help modal — game filter section
  helpGame: string;
  helpGameDesc: string;
  // Help modal — search section + syntax table
  helpSearch: string;
  helpSearchDesc: string;
  searchHelpTitle: string;      // syntax subsection heading
  searchHelpAnd: string;
  searchHelpOr: string;
  searchHelpNot: string;
  searchHelpPhrase: string;
  searchHelpGroup: string;
  searchHelpNote: string;
  // Help modal — date section
  helpDate: string;
  helpDateDesc: string;
  // Help modal — login section
  helpLogin: string;
  helpLoginDescWithDate: (date: string) => string;
  helpLoginDescNoDate: string;
  // Help modal — timezone section (between browsing and layout)
  helpTimezone: string;
  helpTimezoneDesc: string;
  // Help modal — share section
  helpShare: string;
  helpShareDesc: string;
  // Filter tab (shown once the filter bar scrolls out of view)
  filtersTab: string;
  controlsCollapse: string;
  controlsExpand: string;
  // View layout toggle
  viewGrid: string;
  viewList: string;
  viewGridLabel: string;        // short label shown next to icon on narrow screens
  viewListLabel: string;
  // List view column headers
  listColTitle: string;
  listColViews: string;
  listColGame: string;
  listColCreator: string;
  listColDate: string;
  // Settings panel
  tzLabel: string;
  // Embed
  playClip: (title: string) => string;
  openOnTwitch: (title: string) => string;   // clip card/row's icon-only external link
  closeEmbed: string;
  closeModal: string;
  prevClip: string;
  nextClip: string;
  // Dynamic clip card text
  views: (formatted: string) => string;
  creatorLine: (creator: string, date: string) => string;
  // Result count
  resultCount: (n: number) => string;
  // Calendar
  allClips: string;             // default preview label when no date filter and no game filter
  clipCount: (n: number) => string;
  calLegendFewer: string;       // heat-map legend: low end
  calLegendMore: string;        // heat-map legend: high end
  calPreviewMore: (n: number) => string;  // game preview strip: overflow suffix
  dayTooltip: (date: string, n: number) => string;
  monthTooltip: (name: string, n: number) => string;
  weekLabel: (date: string) => string;
  selectWeek: (num: number, date: string) => string;
  monthShort: readonly string[];
  monthLong: readonly string[];
  dayOfWeek: readonly string[];
  // Calendar search notice
  // Calendar view header
  calPrevYear: string;
  calNextYear: string;
  calPrevMonth: string;
  calNextMonth: string;
  calLevelGroup: string;                     // aria-label for the Year / Month toggle
  calLevelYear: string;
  calLevelMonth: string;
  calFilterTo: (period: string) => string;   // button: filter to the period on screen
  calFilteredTo: (period: string) => string; // same button once that period is the filter
  calOpenMonth: (month: string) => string;   // year view: mini-month title tooltip
  // Timeline overview (filter bar)
  timelineLabel: string;
  timelineSelection: string;                 // aria-label of the selection band
  // Hover tooltip's gesture → action rows: over empty space (period: what a
  // double-click selects), over the selection band, over one of its handles.
  timelineTip: (period: string) => [string, string][];
  timelineBandTip: [string, string][];
  timelineHandleTip: [string, string][];
  timelineIntro: string;                     // how-to line under the timeline (hover devices)
  timelineIntroTouch: string;                // …on touch devices
  calHintYear: string;                       // calendar footer hint, year view (hover devices)
  calHintMonth: string;                      // calendar footer hint, month view (hover devices)
  calHandle: string;                         // tooltip on the month view's selection-end handles
  // Live clips pending banner
  newClipsBanner: (n: number) => string;
  showNewClips: string;
}

const en: Translations = {
  searchPlaceholder: 'Search clip titles…',
  sortMostViewed: 'Most Viewed',
  sortLeastViewed: 'Least Viewed',
  sortNewest: 'Newest First',
  sortOldest: 'Oldest First',
  allGames: 'All Games',
  viewCalendar: 'Calendar',
  calHide: 'Hide calendar',
  clearDates: 'Clear dates',
  dateFrom: 'From date',
  dateTo: 'End date',
  loading: 'Loading clips database…',
  noClips: 'No clips match the current filters.',
  clearFilters: 'Clear filters',
  errorTitle: 'Could not load the database.',
  errorHint: 'Try refreshing the page. If the problem persists, the site may be temporarily unavailable.',
  renderError: 'Something went wrong loading clips — try refreshing the page.',
  loginBtn: 'Login with Twitch',
  logoutBtn: 'Log out',
  refreshBtn: 'Fetch latest clips',
  refreshingBtn: 'Fetching…',
  dismissBanner: 'Dismiss',
  loginBannerWithDate: (date) => `Clips up to ${date} are available on this site. Log in with Twitch to view newer ones.`,
  loginBannerNoDate: 'Some recent clips may not yet be available. Log in with Twitch to view the latest clips.',
  filtersTab: 'Filters',
  controlsCollapse: 'Collapse filters',
  controlsExpand: 'Expand filters',
  searchHelpBtn: 'Help',
  helpTitle: 'How to use',
  helpBrowse: 'Watching clips',
  helpBrowseDesc: 'Click a thumbnail (or any row in list view) to watch inline. Use the previous / next clip cards beside the player, or the ← / → keys, to move between clips. Press Escape or click outside to close.',
  helpLayout: 'Grid and list views',
  helpLayoutDesc: 'Toggle between grid (⊞) and list (☰) using the buttons in the filter bar. Grid shows thumbnails; list shows a compact table.',
  helpSort: 'Sorting',
  helpSortDesc: 'Use the sort dropdown to order clips by Most Viewed, Least Viewed, Newest First, or Oldest First.',
  helpGame: 'Game filter',
  helpGameDesc: 'Use the game dropdown to show only clips from one game. You can also click any game name within a clip card to filter by that game instantly.',
  helpSearch: 'Searching',
  helpSearchDesc: 'Type in the search box to filter clips by title.',
  searchHelpTitle: 'Search syntax',
  searchHelpAnd: 'Both words (AND)',
  searchHelpOr: 'Either word (OR)',
  searchHelpNot: 'Include word1, exclude word2 (NOT)',
  searchHelpPhrase: 'Exact phrase',
  searchHelpGroup: 'Grouping',
  searchHelpNote: 'Spaces are required around OR and |.',
  helpDate: 'Filtering by date',
  helpDateDesc: 'Drag across the timeline below the filters to pick a range, then drag the highlighted range to move it or its edges to resize it. Double-click the timeline (double-tap on a touchscreen) to select the year or month there — whichever the calendar’s Year / Month switch shows. You can also type dates into the From / End date boxes. Click the timeline or the Calendar tab under it to open the calendar: click a day or week number to select it, drag across days for a range (on a touchscreen, drag the knobs at the ends of a selection), or use “Filter to …” for the whole month or year on screen. Close it with the tab or the “Hide calendar” handle at its bottom.',
  helpLogin: 'Logging in',
  helpLoginDescWithDate: (date) => `This site's clip data was last updated on ${date}. To view clips newer than this, log in with Twitch — your credentials are used to fetch the latest clips directly from Twitch's servers.`,
  helpLoginDescNoDate: "This site's clip data may not include the most recent clips. Log in with Twitch to fetch the latest clips directly from Twitch's servers.",
  helpTimezone: 'Timezone',
  helpTimezoneDesc: 'Clip dates and times are shown in your selected timezone, automatically set from your browser by default. Click the clock button in the top-right corner to change it.',
  helpShare: 'Sharing a view',
  helpShareDesc: 'Filters, sort order, and page are encoded in the URL — copy the address bar to share exactly what you see.',
  viewGrid: 'Grid view',
  viewList: 'List view',
  viewGridLabel: 'Grid',
  viewListLabel: 'List',
  listColTitle: 'Title',
  listColViews: 'Views',
  listColGame: 'Game',
  listColCreator: 'Creator',
  listColDate: 'Date',
  tzLabel: 'Timezone',
  playClip: (title) => `Play: ${title}`,
  openOnTwitch: (title) => `Open on Twitch: ${title}`,
  closeEmbed: 'Close embed',
  closeModal: 'Close',
  prevClip: 'Previous clip',
  nextClip: 'Next clip',
  views: (f) => `${f} views`,
  creatorLine: (creator, date) => `by ${creator} · ${date}`,
  resultCount: (n) => `${n.toLocaleString()} clip${n !== 1 ? 's' : ''}`,
  allClips: 'All clips',
  clipCount: (n) => `${n.toLocaleString()} clip${n !== 1 ? 's' : ''}`,
  calLegendFewer: 'fewer clips',
  calLegendMore: 'more',
  calPreviewMore: (n) => `+${n} more`,
  dayTooltip: (date, n) => `${date}: ${n} clip${n !== 1 ? 's' : ''}`,
  monthTooltip: (name, n) => `${name}: ${n.toLocaleString()} clip${n !== 1 ? 's' : ''}`,
  weekLabel: (date) => {
    const parts = date.split('-');
    const fmt = new Date(Number(parts[0]!), Number(parts[1]!) - 1, Number(parts[2]!))
      .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    return `Week of ${fmt}`;
  },
  selectWeek: (num, date) => {
    const parts = date.split('-');
    const fmt = new Date(Number(parts[0]!), Number(parts[1]!) - 1, Number(parts[2]!))
      .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    return `Select week ${num} (${fmt})`;
  },
  monthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  monthLong: ['January', 'February', 'March', 'April', 'May', 'June',
              'July', 'August', 'September', 'October', 'November', 'December'],
  dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  calPrevYear: 'Previous year',
  calNextYear: 'Next year',
  calPrevMonth: 'Previous month',
  calNextMonth: 'Next month',
  calLevelGroup: 'Calendar view',
  calLevelYear: 'Year',
  calLevelMonth: 'Month',
  calFilterTo: (p) => `Filter to ${p}`,
  calFilteredTo: (p) => `✓ Filtered to ${p}`,
  calOpenMonth: (m) => `Show ${m}`,
  timelineLabel: 'Clip timeline',
  timelineSelection: 'Selected dates',
  timelineTip: (p) => [['Drag', 'select dates'], ['Click', 'show in calendar'], ['Double-click', `select ${p}`]],
  timelineBandTip: [['Drag', 'move the range'], ['← →', 'previous / next period']],
  timelineHandleTip: [['Drag', 'resize'], ['← →', 'move this end a day']],
  timelineIntro: 'Drag across the timeline to filter by date · click to open the calendar · double-click to select a year or month',
  timelineIntroTouch: 'Tap the timeline to open the calendar · double-tap to select a year or month, then drag its ends to adjust',
  calHintYear: 'Click a month to open it · drag across days to select a range',
  calHintMonth: 'Click a day to select it · drag or Shift-click for a range',
  calHandle: 'Drag to change the range',
  newClipsBanner: (n) => `${n} new clip${n !== 1 ? 's' : ''} available`,
  showNewClips: 'Show',
};

const ja: Translations = {
  searchPlaceholder: 'クリップタイトルを検索…',
  sortMostViewed: '再生回数が多い順',
  sortLeastViewed: '再生回数が少ない順',
  sortNewest: '新しい順',
  sortOldest: '古い順',
  allGames: 'すべてのゲーム',
  viewCalendar: 'カレンダー',
  calHide: 'カレンダーを閉じる',
  clearDates: '日付フィルターをクリア',
  dateFrom: '開始日',
  dateTo: '終了日（当日含む）',
  loading: 'クリップデータベースを読み込み中…',
  noClips: '条件に一致するクリップがありません。',
  clearFilters: 'フィルターをクリア',
  errorTitle: 'データベースを読み込めませんでした。',
  errorHint: 'ページを更新してみてください。問題が解決しない場合、このサイトが一時的に利用できない状態になっている可能性があります。',
  renderError: 'クリップの読み込みに失敗しました。ページを更新してみてください。',
  loginBtn: 'Twitchでログイン',
  logoutBtn: 'ログアウト',
  refreshBtn: '新着クリップ更新',
  refreshingBtn: '更新中…',
  dismissBanner: '閉じる',
  loginBannerWithDate: (date) => `${date}までのクリップが見られます。それ以降の新着クリップを見るにはTwitchでログインしてください。`,
  loginBannerNoDate: '新着クリップが見られない場合があります。新着クリップを見るにはTwitchでログインすると見られます。',
  filtersTab: 'フィルター',
  controlsCollapse: 'フィルターを折りたたむ',
  controlsExpand: 'フィルターを展開する',
  searchHelpBtn: 'ヘルプ',
  helpTitle: '使い方',
  helpBrowse: 'クリップを見る',
  helpBrowseDesc: 'サムネイルをクリック（リスト表示では行をクリック）するとその場で再生できます。プレイヤー横の「前のクリップ」「次のクリップ」または ← / → キーで前後のクリップに移動できます。Escキーまたは外側をクリックで閉じます。',
  helpLayout: 'グリッドとリスト表示',
  helpLayoutDesc: 'フィルターバーのボタンでグリッド（⊞）とリスト（☰）を切り替えられます。グリッドはサムネイル付き、リストはコンパクトな一覧表示です。',
  helpSort: '並び替え',
  helpSortDesc: '並び替えメニューで、再生回数の多い順・少ない順、新しい順・古い順に並べ替えられます。',
  helpGame: 'ゲームで絞り込む',
  helpGameDesc: 'ゲームメニューで1つのゲームのクリップだけを表示できます。クリップカード内のゲーム名をクリックすると、そのゲームで即座に絞り込めます。',
  helpSearch: '検索',
  helpSearchDesc: '検索ボックスに入力するとタイトルで絞り込めます。',
  searchHelpTitle: '検索の使い方',
  searchHelpAnd: '両方の語を含む（AND）',
  searchHelpOr: 'どちらかの語を含む（OR）',
  searchHelpNot: '前者を含んで後者を除外（NOT）',
  searchHelpPhrase: 'フレーズ検索',
  searchHelpGroup: 'グループ化',
  searchHelpNote: 'OR・|・｜ の前後にはスペースが必要です。',
  helpDate: '日付で絞り込む',
  helpDateDesc: 'フィルター下のタイムラインをドラッグして期間を選択できます。選択した範囲はドラッグで移動、端をドラッグで伸縮できます。タイムラインをダブルクリック（タッチ操作ではダブルタップ）すると、その位置の年または月（カレンダーの「年／月」の切り替えに合わせて）を選択できます。開始日・終了日に直接入力することもできます。タイムラインかその下の「カレンダー」タブをクリックするとカレンダーが開き、日や週番号のクリックで選択、日のドラッグ（タッチ操作では選択範囲の端のつまみをドラッグ）で期間を選択、「〜で絞り込む」で表示中の月・年を選択できます。カレンダーはタブか下端の「カレンダーを閉じる」で閉じられます。',
  helpLogin: 'ログイン',
  helpLoginDescWithDate: (date) => `このサイトのクリップデータは${date}時点のものです。それ以降の新着クリップを見るには、Twitchでログインしてください。ログインすると、Twitchのサーバーから新着クリップを直接読み込めます。`,
  helpLoginDescNoDate: 'このサイトのクリップデータには、新着クリップが含まれていない場合があります。Twitchでログインすると、Twitchのサーバーから新着クリップを直接読み込めます。',
  helpTimezone: 'タイムゾーン',
  helpTimezoneDesc: 'クリップの日時は選択中のタイムゾーンで表示されます。初期設定ではブラウザのタイムゾーンが自動的に適用されます。変更するには、右上の時計ボタンをクリックしてください。',
  helpShare: 'URLで共有',
  helpShareDesc: 'フィルターや並び順などのページの状態はURLに反映されます。アドレスバーをコピーしてそのまま共有できます。',
  viewGrid: 'グリッド表示',
  viewList: 'リスト表示',
  viewGridLabel: 'グリッド',
  viewListLabel: 'リスト',
  listColTitle: 'タイトル',
  listColViews: '再生数',
  listColGame: 'ゲーム',
  listColCreator: '作成者',
  listColDate: '日時',
  tzLabel: 'タイムゾーン',
  playClip: (title) => `「${title}」を再生`,
  openOnTwitch: (title) => `「${title}」をTwitchで開く`,
  closeEmbed: '閉じる',
  closeModal: '閉じる',
  prevClip: '前のクリップ',
  nextClip: '次のクリップ',
  views: (f) => `${f}回視聴`,
  creatorLine: (creator, date) => `作成者: ${creator}さん · ${date}`,
  resultCount: (n) => `${n.toLocaleString()}本のクリップ`,
  allClips: 'すべてのクリップ',
  clipCount: (n) => `${n.toLocaleString()}本`,
  calLegendFewer: 'クリップが少ない',
  calLegendMore: '多い',
  calPreviewMore: (n) => `他${n}件`,
  dayTooltip: (date, n) => {
    const parts = date.split('-');
    const fmt = new Date(Number(parts[0]!), Number(parts[1]!) - 1, Number(parts[2]!))
      .toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });
    return `${fmt}：${n}本`;
  },
  monthTooltip: (name, n) => `${name}：${n.toLocaleString()}本`,
  weekLabel: (date) => {
    const parts = date.split('-');
    const fmt = new Date(Number(parts[0]!), Number(parts[1]!) - 1, Number(parts[2]!))
      .toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    return `週：${fmt}`;
  },
  selectWeek: (num, date) => {
    const parts = date.split('-');
    const fmt = new Date(Number(parts[0]!), Number(parts[1]!) - 1, Number(parts[2]!))
      .toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    return `第${num}週 (${fmt}) を選択`;
  },
  monthShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  monthLong: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  dayOfWeek: ['日', '月', '火', '水', '木', '金', '土'],
  calPrevYear: '前の年',
  calNextYear: '次の年',
  calPrevMonth: '前の月',
  calNextMonth: '次の月',
  calLevelGroup: 'カレンダーの表示',
  calLevelYear: '年',
  calLevelMonth: '月',
  calFilterTo: (p) => `${p}で絞り込む`,
  calFilteredTo: (p) => `✓ ${p}で絞り込み中`,
  calOpenMonth: (m) => `${m}を表示`,
  timelineLabel: 'クリップのタイムライン',
  timelineSelection: '選択中の期間',
  timelineTip: (p) => [['ドラッグ', '期間を選択'], ['クリック', 'カレンダーに表示'], ['ダブルクリック', `${p}を選択`]],
  timelineBandTip: [['ドラッグ', '範囲を移動'], ['← →', '前後の期間へ']],
  timelineHandleTip: [['ドラッグ', '伸縮'], ['← →', 'この端を1日ずつ移動']],
  timelineIntro: 'タイムラインをドラッグで期間を選択・クリックでカレンダーを表示・ダブルクリックで年／月を選択',
  timelineIntroTouch: 'タイムラインをタップでカレンダーを表示・ダブルタップで年／月を選択し、両端のドラッグで調整',
  calHintYear: 'クリックで月を表示・日をドラッグで期間を選択',
  calHintMonth: 'クリックで日を選択・ドラッグかShift+クリックで期間を選択',
  calHandle: 'ドラッグで期間を変更',
  newClipsBanner: (n) => `新着クリップ${n}件`,
  showNewClips: '表示',
};

const DICTS: Record<Lang, Translations> = { en, ja };

export let lang: Lang = 'ja';

export function detectLang(): Lang {
  const pref = (navigator.languages?.[0] ?? navigator.language) ?? '';
  return pref.toLowerCase().startsWith('en') ? 'en' : 'ja';
}

export function setLang(l: Lang): void {
  lang = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

export function t(): Translations {
  return DICTS[lang];
}
