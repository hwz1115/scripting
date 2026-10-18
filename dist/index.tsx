// 版本：0.4.0
// 日期：2026-10-18
// 0.4.0：新增历史记录（自动保存出现过的网址，可切换查看、可清空；最多保留 3000 条）
// 0.3.2：修复运行报错 Cannot find name 'setInterval' / 'clearInterval'（Scripting 里没有这两个名字，改用 setTimeout 循环实现自动刷新）
// 0.3.1：修复 0.3.0 压缩包里 script.json 是空的、导致 Scripting 报“不支持的脚本文件”
// 0.3.0：新增自动刷新（关闭 / 3秒 / 5秒 / 10秒，点一下循环切换）
// 0.2.0：密钥不再写在代码里，首次运行时在界面里粘贴并保存到手机（可以放心放公开仓库）
// 0.1.1：修复筛选按钮点不动（一行放多个按钮会被一起触发，改成一行一个按钮，点一下循环切换）
// 作用：读取 Surge 的 DNS 缓存，显示每个网址走了哪个 DNS、用时多久、查到哪些 IP
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
};

// 历史记录：同一个网址 + 同一个 DNS 服务器算一条
type Hist = {
  domain: string;
  server: string;
  ips: string;
  cost: number;
  first: number; // 第一次出现的时间（毫秒）
  last: number; // 最近一次出现的时间（毫秒）
};

// 界面上一行要显示的内容（缓存和历史共用）
type Row = {
  domain: string;
  server: string;
  cost: number;
  ips: string;
  extra: string;
};

// 历史的“唯一正本”放在这里，界面里的 state 只是用来刷新显示
let histStore: Hist[] = [];
let mergeCount = 0;

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
    const old = index[k];
    if (old) {
      old.last = now;
      old.cost = cost;
      if (ips) old.ips = ips;
    } else {
      const h: Hist = { domain: e.domain, server: e.server || '', ips, cost, first: now, last: now };
      histStore.push(h);
      index[k] = h;
      added += 1;
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
  if (kind === '国内') return 'systemGreen';
  if (kind === '国外') return 'systemBlue';
  if (kind === '系统') return 'systemOrange';
  return 'secondaryLabel';
}

function ms(sec: number): string {
  if (typeof sec !== 'number') return '—';
  return `${Math.round(sec * 1000)}ms`;
}

function nowText(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function SurgeDnsApp({ initial, initialKey }: { initial: Entry[]; initialKey: string }) {
  const [key, setKey] = useState<string>(initialKey);
  const [keyInput, setKeyInput] = useState<string>('');
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [filter, setFilter] = useState<string>('全部');
  const [q, setQ] = useState<string>('');
  const [msg, setMsg] = useState<string>(initialKey ? '' : '首次使用：请在下方粘贴 Surge 的 http-api 密钥并保存');
  const [updated, setUpdated] = useState<string>(nowText());
  const [auto, setAuto] = useState<number>(0);
  const [view, setView] = useState<string>('缓存');
  const [hist, setHist] = useState<Hist[]>(histStore.slice());
  const [confirmClear, setConfirmClear] = useState<boolean>(false);

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

  const cacheRows: Row[] = entries.map((e) => ({
    domain: e.domain,
    server: e.server,
    cost: e.timeCost,
    ips: (e.data || []).slice(0, 2).join(', '),
    extra: '',
  }));
  const histRows: Row[] = hist
    .slice()
    .sort((a, b) => b.last - a.last)
    .map((h) => ({
      domain: h.domain,
      server: h.server,
      cost: h.cost,
      ips: h.ips,
      extra: `首次 ${timeText(h.first)} · 最近 ${timeText(h.last)}`,
    }));
  const base: Row[] = view === '历史' ? histRows : cacheRows;

  const count = (k: string) => base.filter((r) => kindOf(r.server) === k).length;

  const shown = base.filter((r) => {
    const okKind = filter === '全部' || kindOf(r.server) === filter;
    const okText = !q || (r.domain || '').toLowerCase().includes(q.toLowerCase());
    return okKind && okText;
  });

  return (
    <NavigationStack>
      <List
        navigationTitle="Surge DNS 观察 v0.4.0"
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
          footer={<Text>最后更新：{updated}　（历史只在脚本打开并刷新时记录；Surge 自己只保留约 200 条缓存）</Text>}
        >
          <HStack>
            <Text>{view === '历史' ? '历史共' : '缓存共'} {base.length} 条</Text>
            <Spacer />
            <Text foregroundStyle="systemGreen">国内 {count('国内')}</Text>
            <Text foregroundStyle="systemBlue">国外 {count('国外')}</Text>
            <Text foregroundStyle="systemOrange">系统 {count('系统')}</Text>
          </HStack>
          <Button
            title={`视图：${view === '历史' ? '历史记录' : '当前缓存'}（点一下切换）`}
            action={() => {
              setView(view === '历史' ? '缓存' : '历史');
              setConfirmClear(false);
            }}
          />
          <Button
            title={`筛选：${filter}（点一下切换）`}
            action={() => {
              const order = ['全部', '国内', '国外', '其他'];
              setFilter(order[(order.indexOf(filter) + 1) % order.length]);
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

        <Section header={<Text>{`${view === '历史' ? '历史记录' : '解析记录'}（${shown.length}）`}</Text>}>
          {shown.map((r, i) => {
            const k = kindOf(r.server);
            return (
              <VStack alignment="leading" key={`${r.domain}-${r.server}-${i}`}>
                <Text bold>{r.domain}</Text>
                <HStack>
                  <Text font="caption" bold foregroundStyle={colorOf(k)}>{k}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel">
                    {r.server || '—'} · {ms(r.cost)}
                  </Text>
                </HStack>
                <Text font="caption" foregroundStyle="secondaryLabel">{r.ips || '无 IP'}</Text>
                {r.extra ? <Text font="caption" foregroundStyle="secondaryLabel">{r.extra}</Text> : null}
              </VStack>
            );
          })}
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
  if (key) {
    try {
      const j = await api('/v1/dns', key);
      initial = j.dnsCache || [];
      mergeHist(initial);
    } catch {}
  }
  running = true;
  scheduleTick();
  await Navigation.present({
    element: <SurgeDnsApp initial={initial} initialKey={key} />,
    modalPresentationStyle: 'pageSheet',
  });
  running = false;
  Script.exit();
}

run();
