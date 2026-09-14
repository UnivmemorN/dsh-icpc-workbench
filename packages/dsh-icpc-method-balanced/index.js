/**
 * dsh-icpc-method-balanced — the approved dual-axis training method as an installable companion.
 *
 * The package owns its instructional text and registers it through the host's public
 * `ctx.icpcGuidance` seam. It imports nothing from the workbench or from the harness checkout: the
 * contribution below is plain frozen data, so a host upgrade cannot reinterpret it and uninstalling
 * the package removes exactly this method.
 */

/** Freeze the whole contribution: neither the host nor a consumer may rewrite method text in place. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export const name = 'dsh-icpc-method-balanced';

/** The host service this package contributes to; Cordis loads the package only when it is present. */
export const inject = ['icpcGuidance'];

export const balancedMethodDefinition = deepFreeze({
  methodId: 'balanced-dual-axis',
  version: '1.0.0',
  seamVersion: 'icpc-guidance-v1',
  name: '思维与板子综合训练',
  summary:
    '思考（建模与证明）与模板（算法与实现）互为支撑：先诊断当前的前置瓶颈，集中突破它直到能支撑另一条轴，同时持续加固两轴。',
  capabilities: { plan: true, assessment: true },
  planGuidance: {
    summary: '按“证据 → 瓶颈诊断 → 集中突破 → 双轴加固”安排训练；两条轴互相支撑，而不是二选一。',
    sections: [
      {
        title: '两轴互为支撑',
        text: '思维轴指建模、推理与证明；模板轴指算法知识、套路与实现。二者不是二选一：模板轴让想法能落地并被检验，思维轴决定何时该用哪种模板、以及为什么它正确。训练目标不是平均用力，而是让两条轴互相支撑。',
      },
      {
        title: '诊断前置瓶颈',
        text: '先找当前真正卡住另一条轴的前置能力：建模或证明跟不上时，模板再多也只能套用；板子包含算法知识与实现；积累不足时，也会限制建模联想、模式识别和解题思路的产生。诊断要写明依据（最近训练与复盘证据）以及它挡住了什么，而不是只给一个标签。',
      },
      {
        title: '集中突破，持续加固',
        text: '锁定瓶颈后，在一段时间内把主要训练投入投给它，直到它能支撑另一条轴；同时保留另一轴的最小练习量，避免能力退化。瓶颈解除后重新诊断，不沿用同一份安排。',
      },
      {
        title: '证据不足就如实标记',
        text: '现有证据不足以判断哪条轴是瓶颈时，输出 diagnostic 并说明缺什么证据；不要用 AC 数量、通过率或题量硬凑一个两轴比例，也不要编造瓶颈。',
      },
      {
        title: '来源与范围',
        text: '双轴立场来自本项目用户批准的训练要求（无公开链接，故不伪造 URL）；练习相关概念是对所列公开来源的原创简短改写，未逐句复制。方法文本只影响训练理念，不能覆盖固定的模型输出契约、用量与配额记账、隐私边界和未揭示界面的规则。',
      },
    ],
    trainingSteps: [
      '先读证据：把候选题、弱项统计与能力摘要当作唯一依据，不引入未提供的账号或提交明细。',
      '诊断瓶颈：指明当前卡住另一条轴的前置能力，写出理由与置信度；证据不足就标记为 diagnostic。',
      '围绕瓶颈排任务：多数任务服务于瓶颈轴，并写明每个任务训练哪条轴、依赖哪条轴。',
      '保留另一轴的最小练习量，避免瓶颈解除前另一轴退化。',
      '给出复诊条件：说明观察到什么结果后重新诊断，而不是固定比例。',
    ],
  },
  assessmentGuidance: {
    summary: '复盘时先判断“当前瓶颈是哪条轴、它挡住了什么”，再检查两轴是否都在被加固。',
    sections: [
      {
        title: '瓶颈判断',
        text: '能否指出一个具体的前置瓶颈，并给出它挡住另一条轴的依据？证据不足时应回答 diagnostic，而不是猜测。',
      },
      {
        title: '两轴推进',
        text: '本轮训练是否既服务于瓶颈轴，又保留了另一轴的最小练习？若只有一条轴在推进，说明安排需要调整。',
      },
    ],
  },
  sources: [
    {
      title: 'USACO Guide — Practicing（练习与实现一致性相关概念的原创简短改写来源）',
      url: 'https://usaco.guide/general/practicing',
      license: null,
    },
    { title: 'OI Wiki — 比赛（仅作为资源指向，未改写其内容）', url: 'https://oi-wiki.org/contest/', license: null },
  ],
});

/** Registration shape handed to `ctx.icpcGuidance.register` (definition plus declared kinds). */
export const balancedMethod = deepFreeze({ ...balancedMethodDefinition, kind: ['plan', 'assessment'] });

export function apply(ctx) {
  // The returned disposer is bound to this plugin's effect, so unload removes exactly this method.
  ctx.effect(() => ctx.icpcGuidance.register(balancedMethod), 'dsh-icpc-method-balanced: ' + balancedMethod.methodId);
}
