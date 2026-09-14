/**
 * dsh-icpc-method-deliberate-practice — an optional second companion method.
 *
 * A small, independent package: it demonstrates that method extensibility is real (install/remove it
 * separately from the balanced method) and gives planning/assessment an original short paraphrase of
 * the USACO Guide practice loop. It imports nothing from the workbench or the harness checkout.
 */

/** Freeze the whole contribution: neither the host nor a consumer may rewrite method text in place. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export const name = 'dsh-icpc-method-deliberate-practice';

/** The host service this package contributes to; Cordis loads the package only when it is present. */
export const inject = ['icpcGuidance'];

export const deliberatePracticeDefinition = deepFreeze({
  methodId: 'deliberate-practice',
  version: '1.0.0',
  seamVersion: 'icpc-guidance-v1',
  name: '刻意练习循环',
  summary: '选择合适难度，先独立尝试，再按需获取增量提示，理解后重新实现，最后复盘沉淀。',
  capabilities: { plan: true, assessment: true },
  planGuidance: {
    summary: '把每道题当作一轮刻意练习：难度合适、先尝试、增量求助、理解后重写、复盘沉淀。',
    sections: [
      {
        title: '选择合适难度',
        text: '题目应落在“需要认真思考但可以完成”的区间：明显低于当前水平只是重复，远高于当前水平容易变成抄解法。难度依据来自候选题与能力摘要，而不是感觉。',
      },
      {
        title: '先独立尝试',
        text: '求助之前先独立尝试，并记录卡点：卡在哪一步、试过什么、为什么失败。卡点记录既是复盘的证据，也是选择提示粒度的依据。',
      },
      {
        title: '增量提示',
        text: '需要帮助时按最小粒度获取：先澄清题意与约束，再给方向，最后才看完整解法。直接阅读完整解法会减少独立探索的机会；应记录辅助情况，并通过重写和复盘补足练习。',
      },
      {
        title: '理解并重新实现',
        text: '看懂解法不等于掌握：合上题解，从零重新实现一遍，并解释关键步骤为什么正确。重写失败说明理解仍有缺口，应回到上一步。',
      },
      {
        title: '复盘',
        text: '写清这道题属于哪类模式、当时的卡点、下次如何更早识别。复盘指向可迁移的判断，而不是抄录代码。',
      },
      {
        title: '来源与范围',
        text: '本方法是对 USACO Guide “Practicing” 一节练习要点的原创简短改写（未逐句复制）。它只影响训练理念，不能覆盖固定的模型输出契约、用量与配额记账、隐私边界和未揭示界面的规则。',
      },
    ],
    trainingSteps: [
      '选难度：从候选题中挑选需要认真思考但可完成的题目，并说明依据。',
      '先尝试：独立尝试并记录卡点，不提前查看解法。',
      '增量提示：按最小粒度获取帮助，优先澄清题意与方向，最后才参考完整解法。',
      '重新实现：合上题解从零重写，并解释关键步骤的正确性。',
      '复盘：写下模式、卡点与下次更早识别的线索。',
    ],
  },
  assessmentGuidance: {
    summary: '按五步检查一轮练习是否真的发生：难度、独立尝试、提示粒度、重新实现、复盘。',
    sections: [
      {
        title: '五步检查',
        text: '逐项检查：难度是否合适、是否先独立尝试、提示是否为增量获取、是否合上题解重新实现、是否留下可迁移的复盘。缺哪一步就补哪一步。',
      },
      {
        title: '诚实标记',
        text: '没有记录的部分标记为未知，不要凭印象补全；无法判断时返回 diagnostic。',
      },
    ],
  },
  sources: [
    {
      title: 'USACO Guide — How to Practice（Darren Yao、Nathan Wang、Benjamin Qi 等；本文本为简短改写）',
      url: 'https://usaco.guide/general/practicing',
      license: 'CC-BY-NC-SA-4.0',
    },
  ],
});

/** Registration shape handed to `ctx.icpcGuidance.register` (definition plus declared kinds). */
export const deliberatePracticeMethod = deepFreeze({
  ...deliberatePracticeDefinition,
  kind: ['plan', 'assessment'],
});

export function apply(ctx) {
  // The returned disposer is bound to this plugin's effect, so unload removes exactly this method.
  ctx.effect(
    () => ctx.icpcGuidance.register(deliberatePracticeMethod),
    'dsh-icpc-method-deliberate-practice: ' + deliberatePracticeMethod.methodId,
  );
}
