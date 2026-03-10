export type Lang = 'en' | 'ja';

export interface Translations {
  // Controls
  searchPlaceholder: string;
  sortMostViewed: string;
  sortLeastViewed: string;
  sortNewest: string;
  sortOldest: string;
  allGames: string;
  viewGrid: string;
  viewCalendar: string;
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
  // Search help modal
  searchHelpBtn: string;
  searchHelpTitle: string;
  searchHelpAnd: string;
  searchHelpOr: string;
  searchHelpNot: string;
  searchHelpPhrase: string;
  searchHelpNote: string;
  // Settings panel
  tzLabel: string;
  // Embed
  closeEmbed: string;
  prevClip: string;
  nextClip: string;
  // Dynamic clip card text
  views: (formatted: string) => string;
  creatorLine: (creator: string, date: string) => string;
  // Result count
  resultCount: (n: number) => string;
  // Calendar
  clipCount: (n: number) => string;
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
  viewGrid: 'Browse',
  viewCalendar: 'Calendar',
  dateFrom: 'From date',
  dateTo: 'To date (inclusive)',
  loading: 'Loading clips database…',
  noClips: 'No clips match your search.',
  errorTitle: 'Could not load the database.',
  errorHint: 'Try refreshing the page. If the problem persists, the archive may be temporarily unavailable.',
  renderError: 'Something went wrong loading clips — try refreshing the page.',
  loginBtn: 'Login with Twitch',
  logoutBtn: 'Log out',
  refreshBtn: 'Fetch latest clips',
  refreshingBtn: 'Fetching…',
  dismissBanner: 'Dismiss',
  loginBannerWithDate: (date) => `This archive was last updated ${date}. Log in with Twitch to see newer clips.`,
  loginBannerNoDate: 'Log in with Twitch to see clips newer than this archive.',
  liveTitle: (n, date) => `${n} new ${n === 1 ? 'clip' : 'clips'} since ${date}`,
  liveTitleNoDate: (n) => `${n} new ${n === 1 ? 'clip' : 'clips'}`,
  liveSectionShow: 'Show',
  liveSectionCollapse: 'Collapse',
  searchHelpBtn: 'Search help',
  searchHelpTitle: 'Search syntax',
  searchHelpAnd: 'Both words (AND)',
  searchHelpOr: 'Either word (OR)',
  searchHelpNot: 'Exclude word',
  searchHelpPhrase: 'Exact phrase',
  searchHelpNote: 'Spaces are required around OR and |.',
  tzLabel: 'Timezone',
  closeEmbed: 'Close embed',
  prevClip: 'Previous clip',
  nextClip: 'Next clip',
  views: (f) => `${f} views`,
  creatorLine: (creator, date) => `by ${creator} · ${date}`,
  resultCount: (n) => `${n.toLocaleString()} clip${n !== 1 ? 's' : ''}`,
  clipCount: (n) => `${n} clip${n !== 1 ? 's' : ''}`,
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
  viewGrid: '一覧',
  viewCalendar: 'カレンダー',
  dateFrom: '開始日',
  dateTo: '終了日（当日含む）',
  loading: 'クリップデータベースを読み込み中…',
  noClips: '検索に一致するクリップがありません。',
  errorTitle: 'データベースを読み込めませんでした。',
  errorHint: 'ページを更新してみてください。問題が解決しない場合、アーカイブが一時的に利用できない状態になっている可能性があります。',
  renderError: 'クリップの読み込みに失敗しました。ページを更新してみてください。',
  loginBtn: 'Twitchでログイン',
  logoutBtn: 'ログアウト',
  refreshBtn: '新着クリップ更新',
  refreshingBtn: '更新中…',
  dismissBanner: '閉じる',
  loginBannerWithDate: (date) => `アーカイブの最終更新：${date}。それ以降の新しいクリップを見るには、Twitchでログインしてください。`,
  loginBannerNoDate: 'アーカイブより新しいクリップを見るにはTwitchでログインしてください。',
  liveTitle: (n, date) => `${date}以降の新着クリップ（${n}本）`,
  liveTitleNoDate: (n) => `新着クリップ（${n}本）`,
  liveSectionShow: '表示',
  liveSectionCollapse: '折りたたむ',
  searchHelpBtn: '検索ヘルプ',
  searchHelpTitle: '検索の使い方',
  searchHelpAnd: '両方の語を含む（AND）',
  searchHelpOr: 'どちらかの語を含む（OR）',
  searchHelpNot: '語を除外',
  searchHelpPhrase: 'フレーズ検索',
  searchHelpNote: 'OR・|・｜ の前後にはスペースが必要です。',
  tzLabel: 'タイムゾーン',
  closeEmbed: '閉じる',
  prevClip: '前のクリップ',
  nextClip: '次のクリップ',
  views: (f) => `${f}回視聴`,
  creatorLine: (creator, date) => `作成者: ${creator}さん · ${date}`,
  resultCount: (n) => `${n.toLocaleString()}本のクリップ`,
  clipCount: (n) => `${n}本`,
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
