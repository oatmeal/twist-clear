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
  langToggle: string;
  // Loading / empty / error
  loading: string;
  noClips: string;
  errorTitle: string;
  errorHint: string;
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
  langToggle: '日本語',
  loading: 'Loading clips database…',
  noClips: 'No clips match your search.',
  errorTitle: 'Could not load the database.',
  errorHint: 'Make sure you are serving this page over HTTP and that <code>clips.db</code> is accessible. Run: <code>npm run dev</code> from the frontend/ directory.',
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
  langToggle: 'English',
  loading: 'クリップデータベースを読み込み中…',
  noClips: '検索に一致するクリップがありません。',
  errorTitle: 'データベースを読み込めませんでした。',
  errorHint: 'HTTPでページを提供し、<code>clips.db</code>にアクセスできることを確認してください。フロントエンドディレクトリから <code>npm run dev</code> を実行してください。',
  views: (f) => `${f}回視聴`,
  creatorLine: (creator, date) => `${creator} · ${date}`,
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
