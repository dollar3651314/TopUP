/**
 * 三种构建：
 * - 生产（APP_ENV=production）：正常页面。
 * - 测试环境（APP_ENV=staging）：真实接口，页面顶部显示"测试环境 STAGING"，全部 noindex。
 * - 原型（PROTOTYPE=1）：页面顶部显示"这是原型"，表单提交返回模拟结果，不调用后端。
 */
export const IS_STAGING = process.env.APP_ENV === 'staging';
export const IS_PROTOTYPE = !IS_STAGING && process.env.PROTOTYPE === '1';
