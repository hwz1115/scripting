// 版本：0.6.0
// 日期：2026-10-18
// 0.6.0：新增“最近请求”——显示每个网址走直连、代理还是被拦截、命中哪条规则；DNS 记录里也会显示它最近走的线路；历史记录会保存线路
// 0.5.0：新增“展开详情”（全部 IP、别名链、缓存到期时间、解析过程）；去掉搜索框下的临时调试行
// 0.4.1：修复搜索搜不到（去掉首尾空格和隐藏字符；多个词用空格隔开表示“同时包含”）
// 0.4.0：新增历史记录（自动保存出现过的网址，可切换查看、可清空；最多保留 3000 条）
// 0.3.2：用 setTimeout 循环实现自动刷新（Scripting 里没有 setInterval / clearInterval）
// 0.3.0：新增自动刷新（关闭 / 3秒 / 5秒 / 10秒，点一下循环切换）
// 0.2.0：密钥不再写在代码里，首次运行时在界面里粘贴并保存到手机（可以放心放公开仓库）
// 0.1.1：筛选按钮改成一行一个按钮，点一下循环切换
// 作用：读取 Surge 的 DNS 缓存和最近请求，显示每个网址走了哪个 DNS、走了哪条线
// 前提：Surge 的 [General] 里已设置 http-api = 密钥@127.0.0.1:6171

import {
  Script,
  Navigation,
  NavigationStack,
  List,
  Section,
  HStack,
  VStack,
  Text,
  Button,
  TextField,
  Spacer,
  useState,
  Toolbar,
  ToolbarItem,
} from 'scripting';

// Scripting 的类型检查对计时器函数不太一致，这里补一个声明（只影响类型检查，运行时用的是系统自带的）
declare function setTimeout(handler: () => void, ms?: number): any;

const API = 'http://127.0.0.1:6171';
const KEY_NAME = 'surgeDnsApiKey';
const HIST_NAME = 'surgeDnsHistory';
const HIST_MAX = 3000;

// 自动刷新：0 表示关闭；refreshHook 由界面每次渲染时更新
let autoSecond = 0;
let tick = 0;
let loading = false;
let refreshHook: (() => void) | null = null;
let running = true;

// 每秒走一次的循环（用 setTimeout 一层层接下去，退出脚本时 running 变 false 就停）
function scheduleTick() {
  // 万一系统里没有 setTimeout，只是自动刷新不工作，脚本本身仍然能打开
  if (typeof setTimeout === 'undefined') return;
  setTimeout(() => {
    if (!running) return;
    if (autoSecond > 0) {
      tick += 1;
      if (tick >= autoSecond) {
        tick = 0;
        if (refreshHook) refreshHook();
      }
    }
    scheduleTick();
  }, 1000);
}

type Entry = {
  domain: string;
  server: string;
  data: string[];
  timeCost: number;
  path?: string;
  logs?: string[];
  expiresTime?: number;
};

// 最近请求（只取需要的几项）
type Req = {
  id: number;
  host: string; // 例如 ai.example.com:443
  bare: string; // 去掉端口后的小写网址
  method: string;
  policy: string; // 实际走的线路，例如 DIRECT / REJECT / 某个节点名
  rule: string; // 命中的规则，例如 FINAL
  status: string;
  remote: string; // 实际连到的地址
  start: number; // 开始时间（秒）
  kind: string; // 直连 / 代理 / 拦截
  inBytes: number;
  outBytes: number;
  notes: string[];
  timing: string;
};

// 历史记录：同一个网址 + 同一个 DNS 服务器算一条
type Hist = {
  domain: string;
  server: string;
  ips: string;
  cost: number;
  first: number; // 第一次出现的时间（毫秒）
  last: number; // 最近一次出现的时间（毫秒）
  policy?: string; // 最近一次看到的线路
  rule?: string; // 最近一次命中的规则
};

// 界面上一行要显示的内容（三个视图共用）
type Row = {
  key: string;
  domain: string;
  kind: string; // 国内/国外/系统/其他，或 直连/代理/拦截
  sub: string;
  ips: string;
  route: string;
  extra: string;
  detail: string[];
};

// 历史的“唯一正本”放在这里，界面里的 state 只是用来刷新显示
let histStore: Hist[] = [];
let mergeCount = 0;
// 每个网址最近一次的线路（来自最近请求）
let routeMap: { [host: string]: { policy: string; rule: string; kind: string } } = {};

function loadHist(): Hist[] {
  try {
    if (typeof Storage !== 'undefined' && Storage.contains && Storage.contains(HIST_NAME)) {
      const arr = JSON.parse(String(Storage.get<string>(HIST_NAME) || '[]'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch {}
  return [];
}

function saveHist() {
  try {
    Storage.set(HIST_NAME, JSON.stringify(histStore));
  } catch {}
}

// ---- 最近请求的整理 ----
function hostOf(r: any): string {
  let h = String((r && r.remoteHost) || '');
  if (!h) {
    // 只取“网址:端口”部分，不保留后面的路径（路径里可能有订阅密钥之类的内容）
    const u = String((r && r.URL) || '');
    const m = u.match(/^[a-zA-Z]+:\/\/([^\/?#]+)/);
    h = m ? m[1] : u.split('/')[0];
  }
  return h;
}

function bareHost(h: string): string {
  const v6 = h.match(/^\[(.+)\](?::\d+)?$/);
  if (v6) return v6[1].toLowerCase();
  const i = h.lastIndexOf(':');
  if (i > 0 && h.indexOf(':') === i && /^\d+$/.test(h.slice(i + 1))) return h.slice(0, i).toLowerCase();
  return h.toLowerCase();
}

function routeKindOf(policy: string, remote: string, rejected: boolean): string {
  const p = (policy || '').toUpperCase();
  if (rejected || p.indexOf('REJECT') === 0) return '拦截';
  if (p === 'DIRECT' || /\(direct\)/i.test(remote || '')) return '直连';
  return '代理';
}

function parseReqs(list: any[]): Req[] {
  const out: Req[] = [];
  (list || []).forEach((r) => {
    if (!r) return;
    const host = hostOf(r);
    if (!host) return;
    const policy = String(r.policyName || '');
    const remote = String(r.remoteAddress || '');
    const timing = (r.timingRecords || [])
      .map((t: any) => `${mapTiming(String(t.name || ''))} ${typeof t.durationInMillisecond === 'number' ? t.durationInMillisecond : '?'}ms`)
      .join(' · ');
    out.push({
      id: typeof r.id === 'number' ? r.id : 0,
      host,
      bare: bareHost(host),
      method: String(r.method || ''),
      policy,
      rule: String(r.rule || ''),
      status: String(r.status || ''),
      remote,
      start: typeof r.startDate === 'number' ? r.startDate : 0,
      kind: routeKindOf(policy, remote, !!r.rejected),
      inBytes: typeof r.inBytes === 'number' ? r.inBytes : 0,
      outBytes: typeof r.outBytes === 'number' ? r.outBytes : 0,
      notes: Array.isArray(r.notes) ? r.notes.map((x: any) => String(x)) : [],
      timing,
    });
  });
  out.sort((a, b) => b.start - a.start || b.id - a.id);
  return out;
}

function mapTiming(n: string): string {
  if (n === 'Rule Evaluating') return '规则匹配';
  if (n === 'Establishing TCP Connection') return '建立连接';
  return n;
}

// 把每个网址最近一次的线路记下来（先处理旧的，新的覆盖旧的）
function updateRoutes(reqs: Req[]) {
  reqs
    .slice()
    .reverse()
    .forEach((r) => {
      routeMap[r.bare] = { policy: r.policy, rule: r.rule, kind: r.kind };
    });
}

function routeText(policy?: string, rule?: string, kind?: string): string {
  if (!policy && !rule) return '';
  return `线路：${kind ? kind + ' ' : ''}${policy || '—'} · 规则 ${rule || '—'}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 请求的“展开详情”：状态、流量、耗时，以及过程记录里和规则、DNS、TLS 有关的几行
function reqDetailOf(r: Req): string[] {
  const lines: string[] = [];
  lines.push(`状态：${r.status || '—'}　方式：${r.method || '—'}`);
  lines.push(`流量：↓${fmtBytes(r.inBytes)} ↑${fmtBytes(r.outBytes)}`);
  if (r.remote) lines.push(`连到：${r.remote}`);
  if (r.timing) lines.push(`耗时：${r.timing}`);
  r.notes
    .filter((n) => /\[(Rule|DNS|TLS)\]/.test(n))
    .slice(0, 10)
    .forEach((n) => lines.push('· ' + n.replace(/^\d\d:\d\d:\d\d(\.\d+)?\s+/, '')));
  return lines;
}

// 把这一次读到的缓存合并进历史，返回新增了几条
function mergeHist(cache: Entry[]): number {
  const now = Date.now();
  const index: { [k: string]: Hist } = {};
  histStore.forEach((h) => {
    index[h.domain + '|' + h.server] = h;
  });
  let added = 0;
  cache.forEach((e) => {
    if (!e || !e.domain) return;
    const k = e.domain + '|' + (e.server || '');
    const ips = (e.data || []).slice(0, 2).join(', ');
    const cost = typeof e.timeCost === 'number' ? e.timeCost : 0;
    let rec = index[k];
    if (rec) {
      rec.last = now;
      rec.cost = cost;
      if (ips) rec.ips = ips;
    } else {
      rec = { domain: e.domain, server: e.server || '', ips, cost, first: now, last: now };
      histStore.push(rec);
      index[k] = rec;
      added += 1;
    }
    const rt = routeMap[e.domain.toLowerCase()];
    if (rt) {
      rec.policy = rt.policy;
      rec.rule = rt.rule;
    }
  });
  if (histStore.length > HIST_MAX) {
    histStore.sort((a, b) => b.last - a.last);
    histStore = histStore.slice(0, HIST_MAX);
  }
  mergeCount += 1;
  // 有新网址就马上存；没有新网址时每 10 次刷新存一次，减少写入
  if (added > 0 || mergeCount % 10 === 0) saveHist();
  return added;
}

// 生成 DNS 记录“展开详情”里要显示的几行字（来自 Surge 缓存里的完整记录）
function detailOf(e: Entry): string[] {
  const lines: string[] = [];
  lines.push(`全部 IP：${(e.data || []).join(', ') || '无'}`);
  if (e.path) {
    const parts = String(e.path).split(' -> ');
    // 最后一段是 IP 列表，去掉；前面剩下的是别名（CNAME）链
    const chain = parts.filter((x, i) => !(i === parts.length - 1 && /^[0-9a-fA-F:., ]+$/.test(x)));
    if (chain.length > 1) lines.push('别名链：' + chain.join(' → '));
  }
  if (typeof e.expiresTime === 'number') {
    const left = Math.round(e.expiresTime - Date.now() / 1000);
    lines.push(`缓存到期：${timeText(e.expiresTime * 1000)}（${left > 0 ? '还剩 ' + left + ' 秒' : '已过期'}）`);
  }
  (e.logs || []).slice(0, 8).forEach((l) => lines.push('· ' + l));
  return lines;
}

// 把输入的搜索词整理成一组小词：去掉隐藏字符、全角转半角、去掉首尾空格、转小写、按空格拆开
function termsOf(q: string): string[] {
  let t = String(q || '');
  try {
    t = t.normalize('NFKC');
  } catch {}
  t = t.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  return t
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length > 0);
}

function timeText(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- 密钥只保存在手机的 Scripting 里，不在代码中 ----
function loadKey(): string {
  try {
    if (typeof Storage !== 'undefined' && Storage.contains && Storage.contains(KEY_NAME)) {
      return String(Storage.get<string>(KEY_NAME) || '');
    }
  } catch {}
  return '';
}

function saveKey(k: string) {
  try {
    Storage.set(KEY_NAME, k);
  } catch {}
}

async function api(path: string, key: string, method: string = 'GET'): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'X-Key': key },
  });
  return await res.json();
}

// 判断一个 DNS 服务器是国内、国外还是系统
const DOMESTIC = ['223.5.5.5', '223.6.6.6', '119.29.29.29', '180.184.2.2', '180.76.76.76', '101.198.198.198', 'alidns', 'doh.pub', 'dot.pub', 'dns.pub', '360.cn', '114.114'];
const FOREIGN = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', 'dns.google', 'cloudflare', 'one.one.one.one'];

function kindOf(server: string): string {
  const s = (server || '').toLowerCase();
  if (!s) return '未知';
  if (s === 'system') return '系统';
  if (DOMESTIC.some((k) => s.includes(k))) return '国内';
  if (FOREIGN.some((k) => s.includes(k))) return '国外';
  return '其他';
}

function colorOf(kind: string): any {
  if (kind === '国内' || kind === '直连') return 'systemGreen';
  if (kind === '国外' || kind === '代理') return 'systemBlue';
  if (kind === '系统') return 'systemOrange';
  if (kind === '拦截') return 'systemRed';
  return 'secondaryLabel';
}

function ms(sec: number): string {
  if (typeof sec !== 'number') return '—';
  return `${Math.round(sec * 1000)}ms`;
}

function nowText(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

const VIEW_NAMES: { [k: string]: string } = { 缓存: '当前缓存', 历史: '历史记录', 请求: '最近请求' };
const VIEW_ORDER = ['缓存', '历史', '请求'];
const DNS_FILTERS = ['全部', '国内', '国外', '其他'];
const REQ_FILTERS = ['全部', '直连', '代理', '拦截'];

function SurgeDnsApp({ initial, initialReqs, initialKey }: { initial: Entry[]; initialReqs: Req[]; initialKey: string }) {
  const [key, setKey] = useState<string>(initialKey);
  const [keyInput, setKeyInput] = useState<string>('');
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [reqs, setReqs] = useState<Req[]>(initialReqs);
  const [filter, setFilter] = useState<string>('全部');
  const [q, setQ] = useState<string>('');
  const [msg, setMsg] = useState<string>(initialKey ? '' : '首次使用：请在下方粘贴 Surge 的 http-api 密钥并保存');
  const [updated, setUpdated] = useState<string>(nowText());
  const [auto, setAuto] = useState<number>(0);
  const [view, setView] = useState<string>('缓存');
  const [hist, setHist] = useState<Hist[]>(histStore.slice());
  const [confirmClear, setConfirmClear] = useState<boolean>(false);
  const [expandedKey, setExpandedKey] = useState<string>('');

  const load = async (k: string) => {
    if (!k) {
      setMsg('还没有保存密钥：请在下方粘贴并保存');
      return;
    }
    if (loading) return;
    loading = true;
    try {
      const j = await api('/v1/dns', k);
      const cache: Entry[] = j.dnsCache || [];
      // 最近请求读不到也不影响 DNS 部分
      let parsed: Req[] = [];
      try {
        const rj = await api('/v1/requests/recent', k);
        parsed = parseReqs(rj.requests || []);
      } catch {}
      updateRoutes(parsed);
      setReqs(parsed);
      setEntries(cache);
      mergeHist(cache);
      setHist(histStore.slice());
      setUpdated(nowText());
      setMsg('');
    } catch (e: any) {
      setMsg(`读取失败：${e && e.message ? e.message : String(e)}（Surge 是否已开启？密钥是否正确？）`);
    } finally {
      loading = false;
    }
  };
  refreshHook = () => {
    load(key);
  };

  const flush = async () => {
    if (!key) {
      setMsg('还没有保存密钥：请在下方粘贴并保存');
      return;
    }
    try {
      await api('/v1/dns/flush', key, 'POST');
      await load(key);
      setMsg('已清空 DNS 缓存');
    } catch (e: any) {
      setMsg(`清空失败：${e && e.message ? e.message : String(e)}`);
    }
  };

  const clearHist = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    histStore = [];
    saveHist();
    setHist([]);
    setConfirmClear(false);
    setMsg('已清空历史记录');
  };

  const save = async () => {
    const k = keyInput.trim();
    if (!k) {
      setMsg('请先粘贴密钥');
      return;
    }
    saveKey(k);
    setKey(k);
    setKeyInput('');
    await load(k);
  };

  const dnsRow = (e: Entry): Row => {
    const rt = routeMap[(e.domain || '').toLowerCase()];
    return {
      key: `${e.domain}|${e.server || ''}`,
      domain: e.domain,
      kind: kindOf(e.server),
      sub: `${e.server || '—'} · ${ms(e.timeCost)}`,
      ips: (e.data || []).slice(0, 2).join(', ') || '无 IP',
      route: rt ? routeText(rt.policy, rt.rule, rt.kind) : '',
      extra: '',
      detail: detailOf(e),
    };
  };

  const histRow = (h: Hist): Row => ({
    key: `${h.domain}|${h.server || ''}`,
    domain: h.domain,
    kind: kindOf(h.server),
    sub: `${h.server || '—'} · ${ms(h.cost)}`,
    ips: h.ips || '无 IP',
    route: routeText(h.policy, h.rule, h.policy ? routeKindOf(h.policy, '', false) : ''),
    extra: `首次 ${timeText(h.first)} · 最近 ${timeText(h.last)}`,
    detail: [
      `IP：${h.ips || '无'}（历史只保存前 2 个 IP）`,
      `首次出现：${timeText(h.first)}`,
      `最近出现：${timeText(h.last)}`,
      '完整的解析过程请切到“当前缓存”里看',
    ],
  });

  const reqRow = (r: Req): Row => ({
    key: `req-${r.id}`,
    domain: r.host,
    kind: r.kind,
    sub: `${r.policy || '—'} · 规则 ${r.rule || '—'}`,
    ips: r.remote || '',
    route: '',
    extra: `${r.method || ''} · ${r.start ? timeText(r.start * 1000) : ''}`,
    detail: reqDetailOf(r),
  });

  let base: Row[] = [];
  if (view === '请求') {
    base = reqs.map(reqRow);
  } else if (view === '历史') {
    base = hist
      .slice()
      .sort((a, b) => b.last - a.last)
      .map(histRow);
  } else {
    base = entries.map(dnsRow);
  }

  const filters = view === '请求' ? REQ_FILTERS : DNS_FILTERS;
  const cats = view === '请求' ? ['直连', '代理', '拦截'] : ['国内', '国外', '系统'];
  const count = (k: string) => base.filter((r) => r.kind === k).length;

  const terms = termsOf(q);
  const shown = base.filter((r) => {
    const okKind = filter === '全部' || r.kind === filter;
    const name = (r.domain || '').toLowerCase();
    const okText = terms.every((t) => name.includes(t));
    return okKind && okText;
  });

  const viewTitle = view === '请求' ? '最近请求' : view === '历史' ? '历史记录' : '解析记录';
  const totalLabel = view === '请求' ? '请求共' : view === '历史' ? '历史共' : '缓存共';

  return (
    <NavigationStack>
      <List
        navigationTitle="Surge DNS 观察 v0.6.0"
        navigationBarTitleDisplayMode="inline"
        toolbar={
          <Toolbar>
            <ToolbarItem placement="primaryAction">
              <Button title="刷新" action={() => load(key)} />
            </ToolbarItem>
          </Toolbar>
        }
      >
        {msg ? (
          <Section>
            <Text font="caption" foregroundStyle="systemRed">{msg}</Text>
          </Section>
        ) : null}

        <Section
          header={<Text>概览</Text>}
          footer={<Text>最后更新：{updated}　（历史只在脚本打开并刷新时记录；Surge 自己只保留约 200 条 DNS 缓存和最近的请求）</Text>}
        >
          <HStack>
            <Text>{totalLabel} {base.length} 条</Text>
            <Spacer />
            {cats.map((c) => (
              <Text key={c} foregroundStyle={colorOf(c)}>{c} {count(c)}</Text>
            ))}
          </HStack>
          <Button
            title={`视图：${VIEW_NAMES[view]}（点一下切换）`}
            action={() => {
              setView(VIEW_ORDER[(VIEW_ORDER.indexOf(view) + 1) % VIEW_ORDER.length]);
              setFilter('全部');
              setConfirmClear(false);
              setExpandedKey('');
            }}
          />
          <Button
            title={`筛选：${filter}（点一下切换）`}
            action={() => {
              setFilter(filters[(filters.indexOf(filter) + 1) % filters.length]);
            }}
          />
          <Button
            title={`自动刷新：${auto === 0 ? '关闭' : auto + ' 秒'}（点一下切换）`}
            action={() => {
              const order = [0, 3, 5, 10];
              const n = order[(order.indexOf(auto) + 1) % order.length];
              setAuto(n);
              autoSecond = n;
              tick = 0;
            }}
          />
          <TextField title="搜索网址" prompt="输入网址的一部分，例如 baidu" value={q} onChanged={setQ} />
          <Button title="清空 DNS 缓存" action={flush} />
          <Button
            title={confirmClear ? `再点一次确认：清空全部 ${hist.length} 条历史` : `清空历史记录（现有 ${hist.length} 条）`}
            action={clearHist}
          />
        </Section>

        <Section header={<Text>{`${viewTitle}（${shown.length}）`}</Text>}>
          {shown.map((r, i) => (
            <VStack alignment="leading" key={`${r.key}-${i}`}>
              <Text bold>{r.domain}</Text>
              <HStack>
                <Text font="caption" bold foregroundStyle={colorOf(r.kind)}>{r.kind}</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">{r.sub}</Text>
              </HStack>
              {r.ips ? <Text font="caption" foregroundStyle="secondaryLabel">{r.ips}</Text> : null}
              {r.route ? <Text font="caption" foregroundStyle="secondaryLabel">{r.route}</Text> : null}
              {r.extra ? <Text font="caption" foregroundStyle="secondaryLabel">{r.extra}</Text> : null}
              <Button
                title={expandedKey === r.key ? '收起详情' : '展开详情'}
                action={() => setExpandedKey(expandedKey === r.key ? '' : r.key)}
              />
              {expandedKey === r.key
                ? r.detail.map((line, j) => (
                    <Text font="caption" foregroundStyle="secondaryLabel" key={`${r.key}-d${j}`}>
                      {line}
                    </Text>
                  ))
                : null}
            </VStack>
          ))}
        </Section>

        <Section
          header={<Text>密钥设置</Text>}
          footer={<Text>密钥只保存在这台手机的 Scripting 里，不会写进脚本代码。</Text>}
        >
          <Text font="caption" foregroundStyle="secondaryLabel">
            {key ? '当前状态：已保存密钥' : '当前状态：还没有密钥'}
          </Text>
          <TextField title="密钥" prompt={key ? '粘贴新密钥可更换' : '粘贴 http-api 的密钥'} value={keyInput} onChanged={setKeyInput} />
          <Button title="保存密钥" action={save} />
        </Section>
      </List>
    </NavigationStack>
  );
}

async function run() {
  const key = loadKey();
  histStore = loadHist();
  let initial: Entry[] = [];
  let initialReqs: Req[] = [];
  if (key) {
    try {
      const j = await api('/v1/dns', key);
      initial = j.dnsCache || [];
      try {
        const rj = await api('/v1/requests/recent', key);
        initialReqs = parseReqs(rj.requests || []);
      } catch {}
      updateRoutes(initialReqs);
      mergeHist(initial);
    } catch {}
  }
  running = true;
  scheduleTick();
  await Navigation.present({
    element: <SurgeDnsApp initial={initial} initialReqs={initialReqs} initialKey={key} />,
    modalPresentationStyle: 'pageSheet',
  });
  running = false;
  Script.exit();
}

run();
