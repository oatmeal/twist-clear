export type Lang = 'en' | 'ja';

export interface Translations {
  // Controls
  searchPlaceholder: string;
  sortMostViewed: string;
  sortLeastViewed: string;
  sortNewest: string;
  sortOldest: string;
  allGames: string;
  viewCalendar: string;
  clearDates: string;
  dateFrom: string;
  dateTo: string;
  // Loading / empty / error
  loading: string;
  noClips: string;
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
  // Live clips section
  liveTitle: (n: number, date: string) => string;
  liveTitleNoDate: (n: number) => string;
  liveSectionShow: string;
  liveSectionCollapse: string;
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
  // Controls bar collapse toggle (narrow screens)
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
  clipCount: (n: number) => string;
  calLegendFewer: string;       // heat-map legend: low end
  calLegendMore: string;        // heat-map legend: high end
  dayTooltip: (date: string, n: number) => string;
  monthTooltip: (name: string, n: number) => string;
  weekLabel: (date: string) => string;
  selectWeek: (num: number, date: string) => string;
  monthShort: readonly string[];
  monthLong: readonly string[];
  dayOfWeek: readonly string[];
}

const en: Translations = {
  searchPlaceholder: 'Search clip titles…',
  sortMostViewed: 'Most Viewed',
  sortLeastViewed: 'Least Viewed',
  sortNewest: 'Newest First',
  sortOldest: 'Oldest First',
  allGames: 'All Games',
  viewCalendar: 'Calendar',
  clearDates: 'Clear dates',
  dateFrom: 'From date',
  dateTo: 'End date',
  loading: 'Loading clips database…',
  noClips: 'No clips match your search.',
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
  liveTitle: (n, date) => `${n} new ${n === 1 ? 'clip' : 'clips'} since ${date}`,
  liveTitleNoDate: (n) => `${n} new ${n === 1 ? 'clip' : 'clips'}`,
  liveSectionShow: 'Show',
  liveSectionCollapse: 'Collapse',
  controlsCollapse: 'Collapse filters',
  controlsExpand: 'Expand filters',
  searchHelpBtn: 'Help',
  helpTitle: 'How to use',
  helpBrowse: 'Watching clips',
  helpBrowseDesc: 'Click a thumbnail (or any row in list view) to watch inline. Press Escape or click outside to close.',
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
  searchHelpNot: 'Include first word, exclude second word (NOT)',
  searchHelpPhrase: 'Exact phrase',
  searchHelpNote: 'Spaces are required around OR and |.',
  helpDate: 'Filtering by date',
  helpDateDesc: 'Type dates into the From / End date boxes, or click the calendar icon to browse by year, month, week, or day.',
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
  closeEmbed: 'Close embed',
  closeModal: 'Close',
  prevClip: 'Previous clip',
  nextClip: 'Next clip',
  views: (f) => `${f} views`,
  creatorLine: (creator, date) => `by ${creator} · ${date}`,
  resultCount: (n) => `${n.toLocaleString()} clip${n !== 1 ? 's' : ''}`,
  clipCount: (n) => `${n} clip${n !== 1 ? 's' : ''}`,
  calLegendFewer: 'fewer clips',
  calLegendMore: 'more',
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
};

const ja: Translations = {
  searchPlaceholder: 'クリップタイトルを検索…',
  sortMostViewed: '再生回数が多い順',
  sortLeastViewed: '再生回数が少ない順',
  sortNewest: '新しい順',
  sortOldest: '古い順',
  allGames: 'すべてのゲーム',
  viewCalendar: 'カレンダー',
  clearDates: '日付フィルターをクリア',
  dateFrom: '開始日',
  dateTo: '終了日（当日含む）',
  loading: 'クリップデータベースを読み込み中…',
  noClips: '検索に一致するクリップがありません。',
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
  liveTitle: (n, date) => `${date}以降の新着クリップ（${n}本）`,
  liveTitleNoDate: (n) => `新着クリップ（${n}本）`,
  liveSectionShow: '表示',
  liveSectionCollapse: '折りたたむ',
  controlsCollapse: 'フィルターを折りたたむ',
  controlsExpand: 'フィルターを展開する',
  searchHelpBtn: 'ヘルプ',
  helpTitle: '使い方',
  helpBrowse: 'クリップを見る',
  helpBrowseDesc: 'サムネイルをクリック（リスト表示では行をクリック）するとその場で再生できます。Escキーまたは外側をクリックで閉じます。',
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
  searchHelpNote: 'OR・|・｜ の前後にはスペースが必要です。',
  helpDate: '日付で絞り込む',
  helpDateDesc: '開始日・終了日に直接入力するか、カレンダーアイコンをクリックして年・月・週・日単位で選択できます。',
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
  closeEmbed: '閉じる',
  closeModal: '閉じる',
  prevClip: '前のクリップ',
  nextClip: '次のクリップ',
  views: (f) => `${f}回視聴`,
  creatorLine: (creator, date) => `作成者: ${creator}さん · ${date}`,
  resultCount: (n) => `${n.toLocaleString()}本のクリップ`,
  clipCount: (n) => `${n}本`,
  calLegendFewer: 'クリップが少ない',
  calLegendMore: '多い',
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
};

const DICTS: Record<Lang, Translations> = { en, ja };

export let lang: Lang = 'ja';

export function detectLang(): Lang {
  const pref = (navigator.languages?.[0] ?? navigator.language) ?? '';
  return pref.toLowerCase().startsWith('en') ? 'en' : 'ja';
}

export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l;
}

export function t(): Translations {
  return DICTS[lang];
}
