// 版本：0.2.0
// 日期：2026-10-17
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

const API = 'http://127.0.0.1:6171';
const KEY_NAME = 'surgeDnsApiKey';

type Entry = {
  domain: string;
  server: string;
  data: string[];
  timeCost: number;
  path?: string;
};

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

  const load = async (k: string) => {
    if (!k) {
      setMsg('还没有保存密钥：请在下方粘贴并保存');
      return;
    }
    try {
      const j = await api('/v1/dns', k);
      setEntries(j.dnsCache || []);
      setUpdated(nowText());
      setMsg('');
    } catch (e: any) {
      setMsg(`读取失败：${e && e.message ? e.message : String(e)}（Surge 是否已开启？密钥是否正确？）`);
    }
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

  const count = (k: string) => entries.filter((e) => kindOf(e.server) === k).length;

  const shown = entries.filter((e) => {
    const okKind = filter === '全部' || kindOf(e.server) === filter;
    const okText = !q || (e.domain || '').toLowerCase().includes(q.toLowerCase());
    return okKind && okText;
  });

  return (
    <NavigationStack>
      <List
        navigationTitle="Surge DNS 观察 v0.2.0"
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
          footer={<Text>最后更新：{updated}　（Surge 只保留最近约 200 条缓存）</Text>}
        >
          <HStack>
            <Text>共 {entries.length} 条</Text>
            <Spacer />
            <Text foregroundStyle="systemGreen">国内 {count('国内')}</Text>
            <Text foregroundStyle="systemBlue">国外 {count('国外')}</Text>
            <Text foregroundStyle="systemOrange">系统 {count('系统')}</Text>
          </HStack>
          <Button
            title={`筛选：${filter}（点一下切换）`}
            action={() => {
              const order = ['全部', '国内', '国外', '其他'];
              setFilter(order[(order.indexOf(filter) + 1) % order.length]);
            }}
          />
          <TextField title="搜索网址" prompt="输入网址的一部分，例如 baidu" value={q} onChanged={setQ} />
          <Button title="清空 DNS 缓存" action={flush} />
        </Section>

        <Section header={<Text>{`解析记录（${shown.length}）`}</Text>}>
          {shown.map((e, i) => {
            const k = kindOf(e.server);
            const ips = (e.data || []).slice(0, 2).join(', ');
            return (
              <VStack alignment="leading" key={`${e.domain}-${i}`}>
                <Text bold>{e.domain}</Text>
                <HStack>
                  <Text font="caption" bold foregroundStyle={colorOf(k)}>{k}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel">
                    {e.server || '—'} · {ms(e.timeCost)}
                  </Text>
                </HStack>
                <Text font="caption" foregroundStyle="secondaryLabel">{ips || '无 IP'}</Text>
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
  let initial: Entry[] = [];
  if (key) {
    try {
      const j = await api('/v1/dns', key);
      initial = j.dnsCache || [];
    } catch {}
  }
  await Navigation.present({
    element: <SurgeDnsApp initial={initial} initialKey={key} />,
    modalPresentationStyle: 'pageSheet',
  });
  Script.exit();
}

run();
