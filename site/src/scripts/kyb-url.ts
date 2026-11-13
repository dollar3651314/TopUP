// 所有开户接口都走同一个函数：/api/kyb/?g=<分组>&a=<动作>&其他参数。
// 原因：每个动作一个函数时，一次部署有 24 个函数，超过了当时部署平台对函数数量的限制。
// path 沿用原来的写法，例如 'state/'、'file/?id=1'。
export const kybUrl = (group: 'admin' | 'onboarding', path: string) => {
  const [action, q] = path.split('?');
  return `/api/kyb/?g=${group}&a=${action.replace(/\/$/, '')}${q ? '&' + q : ''}`;
};
