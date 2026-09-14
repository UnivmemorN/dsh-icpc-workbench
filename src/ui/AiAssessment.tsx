/**
 * Independent AI ability-assessment page (Sprint 18e).
 *
 * One account's assessment flow, built exclusively on the typed business API
 * (`assessment.config` / `prepare` / `run` / `status` / `cancel` / `history`). The durable attempt is
 * the only source of truth: a free preparation is shown exactly as it was frozen, the paid run is
 * always an explicit click, and every later read (status, history) only reads.
 *
 * Guarantees this component exists to keep:
 *
 * - preparing never calls a model; only the explicit generate button does, and exactly once;
 * - the paid button is disabled while the frozen method selection no longer matches the installed
 *   catalogue or while the stored settings revision moved — the user re-prepares, nothing is
 *   substituted and no estimate is ever rendered as `0`;
 * - status polling runs only for a reserved attempt, never overlaps itself, stops at a terminal
 *   status and on unmount (`usePollAfterSettle`);
 * - a lost HTTP answer costs nothing: the same request id is recovered through `status`/`history`
 *   (the generate button disappears once the row is reserved), and no path re-dispatches a paid call;
 * - the mount site keys this component by `accountId`, so switching accounts unmounts the form and
 *   aborts its in-flight reads (the acknowledged durable work stays owned by the server);
 * - a stored report is rendered as the server validated it (with its captured method citations and
 *   human evidence labels), never re-derived by the browser;
 * - one `useAction` serves prepare/generate/cancel, so at most one mutation is in flight.
 */
import { useEffect, useRef, useState } from 'react';
import type { AssessmentModelEvidence } from '../application/assessment-capture.js';
import type { ApiAssessmentView } from '../application/assessment-api-types.js';
import type { AssessmentAttemptStatus } from '../application/assessment-types.js';
import type { AssessmentReportRecord } from '../domain/assessment.js';
import { api, ApiClientError } from './api.js';
import { AXIS_LABELS, GuidancePicker, GuidanceSources, PRIORITY_LABELS, useGuidance } from './GuidancePicker.js';
import {
  Empty,
  ErrorNotice,
  Notice,
  Panel,
  Stats,
  errorText,
  useAction,
  usePollAfterSettle,
  useRequest,
} from './common.js';
import {
  AI_ASSESSMENT_TITLE,
  ASSESSMENT_CONFIDENCE_LABELS,
  ASSESSMENT_CONFIG_NOTE,
  ASSESSMENT_EVIDENCE_NOTE,
  ASSESSMENT_FROZEN_NOTE,
  ASSESSMENT_GENERATE_LABEL,
  ASSESSMENT_HISTORY_LIMITS,
  ASSESSMENT_HISTORY_NOTE,
  ASSESSMENT_PAID_DISCLOSURE_NOTE,
  ASSESSMENT_PREPARE_FREE_NOTE,
  ASSESSMENT_SECTION_NOTE,
  ASSESSMENT_VERIFICATION_NOTE,
  DEFAULT_ASSESSMENT_HISTORY_LIMIT,
  assessmentAnchorText,
  assessmentCancelText,
  assessmentErrorText,
  assessmentEvidenceRefText,
  assessmentPrepareProblem,
  assessmentRangeText,
  assessmentRetryText,
  assessmentRunNote,
  assessmentRunProblem,
  assessmentStatusLabel,
  assessmentUsageBrief,
  assessmentUsageText,
  assessmentWhenText,
  isAssessmentTerminal,
  newAssessmentRequestId,
  officialRatingText,
  shouldPollAssessment,
  type AssessmentMethodIdentity,
} from './assessment-view.js';

/** One request this page follows: the row the user acted on, plus the last view seen for it. */
interface AssessmentFocus {
  readonly requestId: string;
  readonly accountId: string;
  /** The last view this page saw; a fresh status read replaces it as soon as one answers. */
  readonly view: ApiAssessmentView;
}

/** Transport failure rendered with the stable Chinese assessment copy when the code is known. */
function AssessmentFailure({ error }: { error: unknown }) {
  if (!error) return null;
  const code = error instanceof ApiClientError ? error.code : null;
  return (
    <div className="icpc-notice icpc-error" role="alert">
      {assessmentErrorText(code, errorText(error))}
    </div>
  );
}

/** One stored report, rendered exactly as the server validated it against its own capture. */
function ReportBlock({ record, evidence }: { record: AssessmentReportRecord; evidence: AssessmentModelEvidence | null }) {
  const report = record.report;
  const anchor = evidence?.anchor ?? null;
  return (
    <div>
      <h3>AI 推断报告（不是官方评分）</h3>
      <p>{report.summary}</p>
      <p>
        <strong>{assessmentRangeText({ range: report.estimatedRange, anchor })}</strong>
      </p>
      <p className="icpc-muted">{assessmentAnchorText(anchor)}</p>
      <p>
        置信度：{ASSESSMENT_CONFIDENCE_LABELS[report.confidence]}（{report.confidenceReasons.join('；')}）
      </p>
      {report.confidenceEvidenceRefs.length > 0 && (
        <p className="icpc-muted">
          置信度依据：{report.confidenceEvidenceRefs.map((ref) => assessmentEvidenceRefText(ref, evidence)).join('；')}
        </p>
      )}
      {(['thinking', 'templates'] as const).map((axis) => {
        const value = report[axis];
        return (
          <div key={axis}>
            <h4>{AXIS_LABELS[axis]}</h4>
            <p>{value.assessment}</p>
            {value.uncertainties.length > 0 && (
              <ul className="icpc-diagnosis">
                {value.uncertainties.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {value.evidenceRefs.length > 0 && (
              <p className="icpc-muted">
                证据：{value.evidenceRefs.map((ref) => assessmentEvidenceRefText(ref, evidence)).join('；')}
              </p>
            )}
          </div>
        );
      })}
      <p>优先方向：{PRIORITY_LABELS[report.priority]}</p>
      <p>瓶颈说明：{report.bottleneckReason}</p>
      <p>进入下一阶段的条件：{report.readinessCheck}</p>
      {report.nextSteps.length > 0 && (
        <>
          <h4>建议的下一步</h4>
          <ol>
            {report.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      )}
      <p className="icpc-muted">
        {record.disclosure}
        {ASSESSMENT_VERIFICATION_NOTE}
      </p>
    </div>
  );
}

/**
 * The assessment page of one account: free preparation, one explicit paid run, durable history.
 *
 * The parent mounts it with `key={accountId}`, so a switch unmounts this whole subtree; no form
 * state, focus or in-flight HTTP read can survive into another account.
 */
export function AiAssessment({ accountId }: { accountId: string }) {
  const guidance = useGuidance('assessment', accountId);
  const config = useRequest('assessment.config', {});
  const action = useAction();
  const [focus, setFocus] = useState<AssessmentFocus | null>(null);
  const [prepareNote, setPrepareNote] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_ASSESSMENT_HISTORY_LIMIT);
  const [cursor, setCursor] = useState<string | null>(null);
  const [trail, setTrail] = useState<readonly (string | null)[]>([]);
  const history = useRequest('assessment.history', { accountId, limit, cursor });
  const current = focus !== null && focus.accountId === accountId ? focus : null;
  const statusRead = useRequest(
    'assessment.status',
    current === null ? null : { requestId: current.requestId, accountId },
  );
  const view = statusRead.data ?? current?.view ?? null;
  // Free metadata read only: a reserved, unsettled attempt is followed after the previous read
  // settled; a terminal status stops the poll for good and unmount clears the timer.
  usePollAfterSettle(
    view !== null && statusRead.error === null && shouldPollAssessment(view.status),
    statusRead.pending,
    statusRead.refresh,
    2000,
  );
  // A reserved attempt that settled elsewhere (or through cancel) refreshes the persisted history.
  const lastStatus = useRef<AssessmentAttemptStatus | null>(null);
  useEffect(() => {
    const status = view?.status ?? null;
    const previous = lastStatus.current;
    lastStatus.current = status;
    if (status !== null && previous === 'reserved' && isAssessmentTerminal(status)) history.refresh();
  }, [view?.status, view?.finishedAt]);
  const catalog: readonly AssessmentMethodIdentity[] = guidance.methods.map((method) => ({
    methodId: method.definition.methodId,
    version: method.definition.version,
    methodHash: method.methodHash,
  }));
  const runCheck =
    view === null
      ? null
      : assessmentRunProblem({
          viewMethodIds: view.methodIds,
          viewMethods: view.guidance.methods.map((method) => ({
            methodId: method.methodId,
            version: method.version,
            methodHash: method.methodHash,
          })),
          selectedMethodIds: guidance.ids,
          catalog,
          viewSettingsRevision: view.settingsRevision,
          currentSettingsRevision: config.data?.settingsRevision ?? null,
          settingsUnread: config.error !== null,
        });
  const prepareProblem = assessmentPrepareProblem({
    readPending: guidance.read.pending,
    readFailed: guidance.read.error !== null,
    methodCount: guidance.methods.length,
    selectedCount: guidance.ids.length,
    missing: guidance.missing,
  });

  /** Show one attempt and clear the stale acknowledgement of a previous one. */
  function track(requestId: string, next: ApiAssessmentView) {
    setFocus({ requestId, accountId, view: next });
    setRunNote(null);
    setCancelNote(null);
    statusRead.refresh();
  }

  /** Free preparation: no model call, no charge; the answer is the durable prepared row. */
  function prepare() {
    if (!guidance.ready) return;
    void action.run(async (signal) => {
      const value = await api.request(
        'assessment.prepare',
        { requestId: newAssessmentRequestId(), accountId, methodIds: guidance.ids },
        signal,
      );
      track(value.requestId, value);
      setPrepareNote(`已保存免费准备 ${value.requestId}：未调用模型、未产生费用。确认下方冻结信息后再付费生成。`);
      history.refresh();
      return value;
    });
  }

  /**
   * The one paid action.
   *
   * The request id sent is the prepared row's id, so a lost answer or a retried click can only
   * recover the same durable attempt — the service refuses to dispatch a second call for a row that
   * is already reserved or terminal, and the response reports `started:false`.
   */
  function generate() {
    if (view === null || view.status !== 'prepared' || runCheck === null || runCheck.blocked) return;
    const requestId = view.requestId;
    void action.run(async (signal) => {
      const result = await api.request('assessment.run', { requestId, accountId }, signal).finally(() => { statusRead.refresh(); history.refresh(); });
      track(result.attempt.requestId, result.attempt);
      setRunNote(
        assessmentRunNote({
          started: result.started,
          status: result.attempt.status,
          hasReport: result.attempt.report !== null,
        }),
      );
      history.refresh();
      return result;
    });
  }

  /** Cancel a free preparation or signal an already-reserved owned call. */
  function cancel(requestId: string) {
    void action.run(async (signal) => {
      const result = await api.request('assessment.cancel', { requestId, accountId }, signal).finally(() => { statusRead.refresh(); history.refresh(); });
      track(result.requestId, result);
      setCancelNote(assessmentCancelText(result.status));
      history.refresh();
      return result;
    });
  }

  function refreshStatus() {
    statusRead.refresh();
    history.refresh();
  }

  function showOlder() {
    const next = history.data?.nextCursor ?? null;
    if (next === null) return;
    setTrail((previous) => [...previous, cursor]);
    setCursor(next);
  }

  function showNewer() {
    if (trail.length === 0) return;
    setCursor(trail[trail.length - 1] ?? null);
    setTrail((previous) => previous.slice(0, -1));
  }

  function showLatest() {
    setTrail([]);
    setCursor(null);
  }

  return (
    <>
      <Panel
        title={AI_ASSESSMENT_TITLE}
        tools={
          <button
            type="button"
            disabled={config.pending || guidance.read.pending}
            onClick={() => {
              config.refresh();
              guidance.read.refresh();
            }}
          >
            {config.pending || guidance.read.pending ? '正在读取…' : '刷新配置与方法'}
          </button>
        }
      >
        <p className="icpc-muted">{ASSESSMENT_SECTION_NOTE}</p>

        <details>
          <summary>调用的模型、额度与披露（当前设置）</summary>
          <ErrorNotice error={config.error} />
          {config.error !== null && (
            <button type="button" onClick={config.refresh}>
              重试读取配置
            </button>
          )}
          {config.data === null ? (
            config.pending && <p>正在读取评估配置…</p>
          ) : (
            <>
              <Stats
                items={[
                  { label: '提供方', value: config.data.provider },
                  { label: '分析模型', value: config.data.model },
                  { label: '推理强度', value: config.data.effort },
                  { label: '输出上限', value: config.data.maxOutputTokens + ' tokens' },
                  { label: '请求超时', value: config.data.requestTimeoutMs + ' 毫秒' },
                  {
                    label: '滚动 24 小时调用上限',
                    value: config.data.quota.maxCallsPer24Hours + ' 次 / ' + config.data.quota.windowMs / 3_600_000 + ' 小时',
                  },
                  { label: '一次最多可选方法', value: config.data.maxMethods },
                ]}
              />
              <p className="icpc-muted">{config.data.disclosure}</p>
              <p className="icpc-muted">{ASSESSMENT_CONFIG_NOTE}</p>
            </>
          )}
        </details>

        <GuidancePicker value={guidance} />
        {prepareProblem !== null && (
          <p className="icpc-plan-invalid" role="status">
            {prepareProblem}
          </p>
        )}
        <p className="icpc-muted">{ASSESSMENT_PREPARE_FREE_NOTE}</p>
        <div className="icpc-actions">
          <button className="icpc-primary" type="button" disabled={action.busy || !guidance.ready} onClick={prepare}>
            {action.busy ? '正在准备…' : '免费准备评估（不调用模型）'}
          </button>
          {current !== null && (
            <button
              type="button"
              disabled={action.busy}
              onClick={() => {
                setFocus(null);
                setPrepareNote(null);
                setRunNote(null);
                setCancelNote(null);
              }}
            >
              清除本页显示
            </button>
          )}
        </div>
        <AssessmentFailure error={action.error} />
        {prepareNote !== null && <Notice>{prepareNote}</Notice>}

        {current !== null && view !== null && (
          <section aria-label="当前 AI 评估请求">
            <h3>当前评估请求（{assessmentStatusLabel(view.status)}）</h3>
            <div className="icpc-plan-meta">
              <span>请求：{view.requestId}</span>
              <span>
                {view.status === 'prepared' ? '准备时间' : '预留时间'}：{assessmentWhenText(view.requestedAt)}
              </span>
              {view.finishedAt !== null && <span>结算时间：{assessmentWhenText(view.finishedAt)}</span>}
              <span>设置版本：{view.settingsRevision ?? '未捕获（不能付费生成）'}</span>
              <span>
                提供方 / 模型：{view.provider} / {view.model}
              </span>
            </div>
            <GuidanceSources snapshot={view.guidance} />
            <p className="icpc-muted">{ASSESSMENT_FROZEN_NOTE}</p>
            {view.evidence !== null && (
              <>
                <p>{assessmentAnchorText(view.evidence.anchor)}</p>
                <p className="icpc-muted">{officialRatingText(view.evidence.officialRating)}</p>
                <details>
                  <summary>
                    本次发送给模型的去标识证据（{view.evidence.evidence.length} 条）· 可展开查看确切 JSON
                  </summary>
                  <p className="icpc-muted">{ASSESSMENT_EVIDENCE_NOTE}</p>
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '18rem', overflow: 'auto' }}>
                    {JSON.stringify(view.evidence, null, 2)}
                  </pre>
                </details>
              </>
            )}
            <p className="icpc-plan-usage">{assessmentUsageText(view)}</p>
            {view.error !== null && (
              <div className="icpc-notice icpc-error" role="alert">
                {assessmentErrorText(view.error.code, '调用未成功。')}（{assessmentRetryText(view.error.retryable)}）
              </div>
            )}
            {view.settlementFailure !== null && (
              <div className="icpc-notice icpc-error" role="alert">
                {view.settlementFailure.message}（预留仍然计费，不会自动重试）
              </div>
            )}
            {view.report !== null && <ReportBlock record={view.report} evidence={view.evidence} />}
            {view.status === 'prepared' ? (
              <>
                {runCheck !== null && runCheck.blocked && (
                  <div className="icpc-notice icpc-error" role="alert">
                    {runCheck.message}
                  </div>
                )}
                <div className="icpc-actions">
                  <button
                    className="icpc-primary"
                    type="button"
                    disabled={action.busy || runCheck === null || runCheck.blocked}
                    onClick={generate}
                  >
                    {ASSESSMENT_GENERATE_LABEL}
                  </button>
                  <button type="button" disabled={action.busy} onClick={() => cancel(view.requestId)}>
                    取消这次准备（免费）
                  </button>
                  <button type="button" disabled={statusRead.pending} onClick={refreshStatus}>
                    {statusRead.pending ? '正在读取…' : '刷新状态'}
                  </button>
                </div>
                <p className="icpc-muted">{ASSESSMENT_PAID_DISCLOSURE_NOTE}</p>
                {config.data !== null && (
                  <p className="icpc-muted">
                    冻结的调用配置：{view.provider} / {view.model} · 推理强度 {config.data.effort} · 输出上限{' '}
                    {config.data.maxOutputTokens} tokens · 请求超时 {config.data.requestTimeoutMs} 毫秒 · 滚动 24 小时上限{' '}
                    {config.data.quota.maxCallsPer24Hours} 次（窗口 {config.data.quota.windowMs / 3_600_000} 小时）· 设置版本{' '}
                    {view.settingsRevision ?? '未捕获'}。
                  </p>
                )}
                <p className="icpc-muted">
                  付费生成后若没有看到应答，请先点“刷新状态”：服务已预留的调用会显示为“调用进行中”，不会重复计费，也不会自动重试。
                </p>
              </>
            ) : (
              <div className="icpc-actions">
                <button type="button" disabled={statusRead.pending} onClick={refreshStatus}>
                  {statusRead.pending ? '正在读取…' : '刷新状态'}
                </button>
                {view.status === 'reserved' && (
                  <button type="button" disabled={action.busy} onClick={() => cancel(view.requestId)}>
                    取消这次调用
                  </button>
                )}
              </div>
            )}
            {runNote !== null && <Notice>{runNote}</Notice>}
            {cancelNote !== null && <Notice>{cancelNote}</Notice>}
            <AssessmentFailure error={statusRead.error} />
            {statusRead.data === null && !statusRead.pending && statusRead.error === null && (
              <Notice>服务没有返回这次请求的状态（可能已不存在或不属于当前账号）：以上是最后一次读取到的记录。</Notice>
            )}
            <p className="icpc-muted">{ASSESSMENT_VERIFICATION_NOTE}</p>
          </section>
        )}
      </Panel>

      <Panel
        title="评估历史记录"
        tools={
          <button type="button" disabled={history.pending} onClick={history.refresh}>
            {history.pending ? '正在读取…' : '刷新记录'}
          </button>
        }
      >
        <p className="icpc-muted">{ASSESSMENT_HISTORY_NOTE}</p>
        <div className="icpc-toolbar">
          <label>
            每页条数
            <select
              value={String(limit)}
              disabled={history.pending}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setTrail([]);
                setCursor(null);
              }}
            >
              {ASSESSMENT_HISTORY_LIMITS.map((size) => (
                <option key={size} value={String(size)}>
                  {size} 条
                </option>
              ))}
            </select>
          </label>
        </div>
        <ErrorNotice error={history.error} />
        {history.error !== null && (
          <button type="button" onClick={history.refresh}>
            重试读取记录
          </button>
        )}
        {history.data === null ? (
          <Empty>{history.pending ? '正在读取评估记录…' : '没有可显示的历史记录。'}</Empty>
        ) : history.data.items.length === 0 ? (
          <Empty>当前账号还没有 AI 评估请求记录。免费准备本身也会作为一条记录保留。</Empty>
        ) : (
          <div className="icpc-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间 / 请求</th>
                  <th>状态</th>
                  <th>用量</th>
                  <th>报告</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((item) => (
                  <tr key={item.requestId}>
                    <td>
                      {assessmentWhenText(item.requestedAt)}
                      <span className="icpc-muted">{item.requestId}</span>
                    </td>
                    <td>
                      {assessmentStatusLabel(item.status)}
                      {item.error !== null && item.status !== 'cancelled' && (
                        <span className="icpc-muted">{assessmentErrorText(item.error.code, '调用未成功。')}</span>
                      )}
                      {item.settlementFailure !== null && <span className="icpc-muted">结算失败（预留仍计费）</span>}
                    </td>
                    <td className="icpc-plan-usage">{assessmentUsageBrief(item)}</td>
                    <td>{item.report !== null ? '有报告' : '无报告'}</td>
                    <td>
                      <div className="icpc-plan-actions">
                        <button
                          type="button"
                          onClick={() => {
                            track(item.requestId, item);
                            setPrepareNote(null);
                          }}
                        >
                          查看
                        </button>
                        {(item.status === 'prepared' || item.status === 'reserved') && (
                          <button type="button" disabled={action.busy} onClick={() => cancel(item.requestId)}>
                            取消
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="icpc-actions">
          <button type="button" disabled={trail.length === 0 || history.pending} onClick={showNewer}>
            上一页（较新）
          </button>
          <button
            type="button"
            disabled={history.data?.nextCursor == null || history.pending}
            onClick={showOlder}
          >
            更早的记录
          </button>
          <button type="button" disabled={(cursor === null && trail.length === 0) || history.pending} onClick={showLatest}>
            回到最新
          </button>
        </div>
        <p className="icpc-muted">
          查看历史只读取状态与报告，不会调用模型；已结算的报告随记录一起保留，方法被卸载后引文仍按当时的原文显示。
        </p>
      </Panel>
    </>
  );
}
