/** 本轮授权课程的实际路由/完整目录联合摘要。无原始参数或账户信息。 */
export interface ZhihuishuIdentityEvidence {
  courseId: string;
  catalogue: string;
  /** 仅本轮用户人工对照两个已完成章与当前未完成章后的固定标记证据。 */
  completionMarkers?: 'finish-half-v1';
}
export const ZHIHUISHU_IDENTITY_EVIDENCE: readonly ZhihuishuIdentityEvidence[] = Object.freeze([
  Object.freeze({
    courseId: 'zhs_c_95cb70ff1ed8fa75d06e4fb487bc1b96c480bc4edb723cc15d5688deca1d293f',
    catalogue: 'd12fb94417fe4bc43012086fa3ea1b59e082bae770333cb08ade80154b3a8153',
    completionMarkers: 'finish-half-v1',
  }),
]);
