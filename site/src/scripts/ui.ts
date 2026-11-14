// 页面共用的小工具：生成 DOM、表格、提示、对话框、复制按钮。
// 全部用 textContent 写入文字，不拼接 HTML，避免把数据当成代码执行。
import { renderSVG } from 'uqr';

type Child = Node | string | number | null | undefined | false;
export function h(tag: string, attrs: Record<string, any> = {}, ...kids: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') (e as any)[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'number' ? String(c) : c);
  return e;
}

/** 用 {name} 占位符替换文案里的变量 */
export const tpl = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/**
 * 表格。opts.page：行很多时先显示 size 行，底部"显示更多"按钮每次再显示 size 行；
 * opts.page.note：列表没有取完时（例如超过 1000 条）显示在表格下面的说明。
 */
export function table(cols: string[], rows: Child[][], emptyText: string, opts: { onRow?: (i: number) => void; rowAttrs?: (i: number) => Record<string, any>; page?: { size: number; more: (left: number) => string; note?: string } } = {}): HTMLElement {
  const thead = h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c))));
  const tbody = h('tbody');
  const addRow = (r: Child[], i: number) => {
    const tr = h('tr', { ...(opts.rowAttrs?.(i) || {}) }, ...r.map((c) => h('td', typeof c === 'string' && c.length <= 28 ? { class: 'td-nw' } : {}, c))); // 短文字（时间、金额）不换行
    if (opts.onRow) { tr.tabIndex = 0; tr.addEventListener('click', () => opts.onRow!(i)); tr.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') opts.onRow!(i); }); }
    else tr.classList.add('no-hover');
    tbody.append(tr);
  };
  if (!rows.length) tbody.append(h('tr', { class: 'no-hover' }, h('td', { class: 'muted empty-cell', colSpan: cols.length }, emptyText)));
  const box = h('div', { class: 'table-scroll' }, h('table', { class: 'data-table pay-table' }, thead, tbody));
  const pg = opts.page;
  if (!pg) { rows.forEach(addRow); return box; }
  let shown = 0;
  const more = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-more': '' }) as HTMLButtonElement;
  const step = () => {
    rows.slice(shown, shown + pg.size).forEach((r, k) => addRow(r, shown + k));
    shown = Math.min(rows.length, shown + pg.size);
    more.hidden = shown >= rows.length; more.textContent = pg.more(rows.length - shown);
  };
  more.addEventListener('click', step);
  step();
  return h('div', { class: 'stack-sm' }, box, h('div', { class: 'table-foot' }, more, pg.note ? h('span', { class: 'hint muted' }, pg.note) : null));
}

export const status = (cls: string, text: string) => h('span', { class: `status st-${cls}` }, text);
export const mono = (s: string, title?: string) => h('span', { class: 'mono', title }, s);

export function stat(label: string, value: string, sub = ''): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
}

let toastTimer = 0;
export function toast(root: ParentNode, sel: string, msg: string) {
  const t = root.querySelector<HTMLElement>(sel)!;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

/** 通用对话框：onOk 返回 false 时不关闭（例如校验不通过） */
/**
 * 私钥、助记词输入框：普通文本框 + 遮盖显示（.secret-input），autocomplete=off——不用 type=password，浏览器就不会提示"保存密码"、也不会自动填。
 * 带 data-secret：弹窗关掉、换内容时由 makeDialog 清空（签名失败、直接关窗也不会留在页面里）。
 */
export function secretInput(multiline = false): HTMLInputElement | HTMLTextAreaElement {
  const attrs = { autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: false, 'data-secret': '', 'data-lpignore': 'true', 'data-1p-ignore': '', class: 'mono-input secret-input' };
  return (multiline ? h('textarea', { rows: '3', ...attrs }) : h('input', { type: 'text', ...attrs })) as HTMLInputElement | HTMLTextAreaElement;
}
/** 清空一块区域里所有私钥、助记词输入框 */
export function wipeSecrets(scope: ParentNode) {
  scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-secret]').forEach((el) => { el.value = ''; });
}

export function makeDialog(root: ParentNode, prefix: string) {
  const dlg = root.querySelector<HTMLDialogElement>(`[data-${prefix}dialog]`)!;
  const form = root.querySelector<HTMLFormElement>(`[data-${prefix}dialog-form]`)!;
  const title = root.querySelector<HTMLElement>(`[data-${prefix}dialog-title]`)!;
  const body = root.querySelector<HTMLElement>(`[data-${prefix}dialog-body]`)!;
  const ok = root.querySelector<HTMLButtonElement>(`[data-${prefix}dialog-ok]`)!;
  const cancel = form.querySelector<HTMLButtonElement>('button[value="cancel"]');
  const cancelText = cancel?.textContent || '';
  let handler: (() => boolean | void | Promise<boolean | void>) | null = null;
  // 关窗（取消、Esc、签完）时清空私钥输入框
  dlg.addEventListener('close', () => wipeSecrets(body));
  form.addEventListener('submit', async (e) => {
    const sub = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (sub?.value !== 'ok' || !handler) return;
    e.preventDefault();
    const r = await handler();
    if (r !== false) dlg.close();
  });
  return (t: string, content: Node, okText: string, onOk: typeof handler, danger = false, hideOk = false) => {
    wipeSecrets(body); // 换下一步之前，上一步的私钥输入框先清空
    title.textContent = t; body.replaceChildren(content);
    ok.textContent = okText; ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`; ok.hidden = hideOk; ok.disabled = false;
    // 只看信息的弹窗（hideOk）：只留一个按钮，文字用 okText（例如"关闭"），不再出现意思重复的"取消"和"确定"
    if (cancel) cancel.textContent = hideOk ? okText : cancelText;
    handler = onOk; dlg.showModal();
  };
}

export function copyBtn(text: () => string, label: string, done: string, cls = 'btn btn-outline btn-sm'): HTMLElement {
  const b = h('button', { type: 'button', class: cls }, label) as HTMLButtonElement;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text()); } catch { /* 剪贴板不可用时只改按钮文字 */ }
    b.textContent = done; setTimeout(() => (b.textContent = label), 1500);
  });
  return b;
}

export const qrDataUrl = (text: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderSVG(text, { border: 2 }));

/** 字段错误提示：返回 true 表示有错 */
export function fieldErr(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, msg: string | null): boolean {
  const f = input.closest('.f')!;
  let p = f.querySelector<HTMLElement>('.err');
  if (!p) { p = h('p', { class: 'err' }); f.append(p); }
  p.textContent = msg || '';
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  return !!msg;
}

export function field(id: string, label: string, input: HTMLElement, hint?: string): HTMLElement {
  input.id = id;
  return h('div', { class: 'f' }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
}

export function fmtTime(iso: string, lang: string): string {
  const d = new Date(iso);
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
