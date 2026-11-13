import { start } from './stack.mjs';
export default async function () {
  const stop = await start();
  return stop; // Playwright 在全部测试结束后调用返回的函数做清理
}
