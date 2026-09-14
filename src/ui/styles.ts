/** Scoped workbench styles; host navigation and global reset remain owned by dsh. */
import katexCss from'katex/dist/katex.min.css';
export const styles=`
.icpc-root{--icpc-bg:#f5f6f2;--icpc-card:#fff;--icpc-ink:#20322e;--icpc-muted:#697870;--icpc-line:#dbe3dc;--icpc-accent:#146c58;--icpc-soft:#e8f2ec;background:var(--icpc-bg);color:var(--icpc-ink);font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;height:100%;overflow:auto;min-width:0;box-sizing:border-box}
.icpc-root *{box-sizing:border-box}.icpc-root button,.icpc-root input,.icpc-root select,.icpc-root textarea{font:inherit}.icpc-root button{cursor:pointer;border:1px solid var(--icpc-line);border-radius:7px;background:var(--icpc-card);color:var(--icpc-ink);padding:7px 12px;transition:background .15s}.icpc-root button:hover:not(:disabled){background:var(--icpc-soft);border-color:var(--icpc-accent)}.icpc-root button:disabled{opacity:.48;cursor:default}.icpc-root button.icpc-primary{background:var(--icpc-accent);color:white;border-color:var(--icpc-accent)}.icpc-root :focus-visible{outline:3px solid #77b99c;outline-offset:2px}.icpc-root input,.icpc-root select,.icpc-root textarea{border:1px solid var(--icpc-line);border-radius:6px;padding:8px 10px;background:var(--icpc-card);color:var(--icpc-ink);width:100%;min-width:0}.icpc-root textarea{resize:vertical;min-height:120px}.icpc-root input[type=checkbox]{width:auto;accent-color:var(--icpc-accent)}.icpc-root label{display:flex;flex-direction:column;gap:5px;color:var(--icpc-muted);font-size:12px}.icpc-root h1,.icpc-root h2,.icpc-root h3,.icpc-root p{margin:0}.icpc-root p+p{margin-top:8px}.icpc-root h1{font-size:25px;line-height:1.4;font-weight:650}.icpc-root h2{font-size:16px;font-weight:650}.icpc-root h3{font-size:15px}.icpc-root a{color:var(--icpc-accent);text-decoration:none}.icpc-root a:hover{text-decoration:underline}.icpc-header{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:20px 28px;background:var(--icpc-card);border-bottom:1px solid var(--icpc-line);flex-wrap:wrap}.icpc-brand{display:flex;align-items:center;gap:11px}.icpc-brand strong{display:block;font-size:18px;letter-spacing:.03em}.icpc-brand small{color:var(--icpc-muted);font-size:11px}.icpc-mark{display:grid;place-items:center;width:39px;height:39px;border:1px solid var(--icpc-accent);border-radius:11px;color:var(--icpc-accent);font-size:17px;font-weight:750;letter-spacing:-.08em}.icpc-header-actions,.icpc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.icpc-account{min-width:155px}.icpc-header-actions button{margin-top:16px}.icpc-nav{display:flex;align-items:center;gap:5px;padding:10px 28px;border-bottom:1px solid var(--icpc-line);overflow:auto;white-space:nowrap}.icpc-nav button{border:0;background:transparent;padding:8px 13px}.icpc-nav button[aria-current=page]{color:var(--icpc-accent);background:var(--icpc-soft);font-weight:650}.icpc-nav>span{margin-left:auto;font-size:11px;color:var(--icpc-muted)}.icpc-content{max-width:1480px;margin:0 auto;padding:27px 28px 40px;display:flex;flex-direction:column;gap:16px}.icpc-content>div>*,.icpc-content>*>.icpc-card{margin-bottom:18px}.icpc-page-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:24px}.icpc-page-heading p:not(.icpc-eyebrow){color:var(--icpc-muted);margin-top:8px}.icpc-eyebrow{font-size:10px;letter-spacing:.17em;color:var(--icpc-accent);font-weight:700;margin-bottom:6px!important}.icpc-date{font-size:12px;color:var(--icpc-muted);white-space:nowrap}.icpc-card{background:var(--icpc-card);border:1px solid var(--icpc-line);border-radius:10px;padding:20px;margin-bottom:18px;min-width:0}.icpc-card-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:15px}.icpc-empty{padding:35px 22px;text-align:center;color:var(--icpc-muted);border:1px dashed var(--icpc-line);border-radius:9px;background:var(--icpc-card)}.icpc-notice{padding:10px 13px;border-left:3px solid #88ac9b;background:var(--icpc-soft);font-size:12px;color:var(--icpc-ink);margin:12px 0;white-space:pre-wrap;overflow-wrap:anywhere}.icpc-error{border-left-color:#b05532;background:#fff0e8;color:#84391f}.icpc-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:15px 20px}.icpc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:13px;margin-bottom:24px}.icpc-stats>div{padding:16px 20px;background:var(--icpc-card);border:1px solid var(--icpc-line);border-radius:9px}.icpc-stats span{font-size:12px;color:var(--icpc-muted);display:block}.icpc-stats strong{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}.icpc-task{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 0;border-top:1px solid var(--icpc-line)}.icpc-root article.icpc-task{display:block}.icpc-coaching{margin:22px 0;padding:18px 0;border-top:1px solid var(--icpc-line);border-bottom:1px solid var(--icpc-line)}.icpc-root form>label{margin:10px 0}.icpc-root meter{accent-color:var(--icpc-accent);width:90px}.icpc-task:first-child{border-top:0}.icpc-task small,.icpc-task span{font-size:12px;color:var(--icpc-muted)}.icpc-details{display:grid;grid-template-columns:95px 1fr;gap:9px;margin:0 0 15px}.icpc-details dt{color:var(--icpc-muted)}.icpc-details dd{margin:0;overflow-wrap:anywhere}.icpc-footer{font-size:10px;letter-spacing:.08em;text-align:center;color:var(--icpc-muted);padding:18px}.icpc-add-account{padding:15px 28px;display:flex;gap:14px;align-items:flex-end;background:var(--icpc-soft);flex-wrap:wrap}.icpc-add-account>label{min-width:160px}.icpc-add-account>span{font-size:12px;color:var(--icpc-muted)}.icpc-wrap{overflow-wrap:anywhere}.icpc-table-wrap{overflow:auto}.icpc-root table{width:100%;border-collapse:collapse;font-size:13px}.icpc-root th{text-align:left;color:var(--icpc-muted);font-size:11px;font-weight:500;white-space:nowrap}.icpc-root th,.icpc-root td{padding:11px 9px;border-bottom:1px solid var(--icpc-line)}.icpc-root pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 'Cascadia Code',Consolas,monospace;max-height:550px;overflow:auto;background:var(--icpc-bg);padding:16px;border-radius:6px}.icpc-tags{display:flex;gap:6px;flex-wrap:wrap}.icpc-tag{padding:2px 8px;border-radius:4px;background:var(--icpc-soft);font-size:11px;color:var(--icpc-accent)}.icpc-warning{background:#fff0de;color:#8b5720}.icpc-split{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,1fr);gap:18px}.icpc-toolbar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px}.icpc-toolbar>label{flex:1;min-width:135px}.icpc-check{flex-direction:row!important;align-items:center;gap:8px!important}.icpc-muted{color:var(--icpc-muted);font-size:12px}.icpc-root details>summary{cursor:pointer;font-weight:600;padding:8px 0}.icpc-root code{font-family:'Cascadia Code',Consolas,monospace}
@media(max-width:900px){.icpc-split{grid-template-columns:1fr}.icpc-stats{grid-template-columns:repeat(2,1fr)}.icpc-date{display:none}.icpc-header,.icpc-nav{padding-left:18px;padding-right:18px}.icpc-content{padding:22px 18px}.icpc-header-actions{width:100%}.icpc-account{flex:1}.icpc-nav>span{display:none}}
@media(prefers-color-scheme:dark){.icpc-root{--icpc-bg:#17221f;--icpc-card:#202e29;--icpc-ink:#e4eee8;--icpc-muted:#a6b9ad;--icpc-line:#3b4c43;--icpc-accent:#83cdb1;--icpc-soft:#2b4337}.icpc-root button.icpc-primary{color:#17221f}.icpc-error{background:#4b3027;color:#ffd6bd}.icpc-warning{background:#4b3f29;color:#f4d38e}}.icpc-pager{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 0;min-width:0}
.icpc-pager button{min-width:38px;padding:6px 9px}
.icpc-pager span.icpc-muted{margin-left:auto}
.icpc-pager .icpc-page-current{background:var(--icpc-accent);border-color:var(--icpc-accent);color:#fff;font-weight:650}
.icpc-pager-gap{color:var(--icpc-muted);padding:0 2px}
.icpc-page-jump{display:flex;flex-direction:row;align-items:center;gap:6px;flex:0 0 auto}
.icpc-page-jump label{flex-direction:row;align-items:center;white-space:nowrap}
.icpc-page-jump input{width:76px;text-align:center;padding:6px 8px}
.icpc-bank-table{scroll-margin-top:12px;max-width:100%}
.icpc-bank-table:focus-visible{outline:3px solid #77b99c;outline-offset:2px}
@media(max-width:640px){.icpc-pager{gap:4px}.icpc-pager button{min-width:32px;padding:5px 7px;font-size:12px}.icpc-pager span.icpc-muted{margin-left:0;flex-basis:100%}.icpc-page-jump input{width:58px}.icpc-page-jump label{display:none}}
@media(prefers-color-scheme:dark){.icpc-root button.icpc-page-current{color:#17221f}}
.icpc-hist-pick{flex-direction:row;align-items:center;gap:6px;white-space:nowrap}
.icpc-hist-pick select{width:auto;min-width:110px}
.icpc-hist-summary{margin-bottom:10px}
.icpc-hist-table td:first-child,.icpc-hist-table td:nth-child(2){white-space:nowrap;font-variant-numeric:tabular-nums}
.icpc-hist-bar{display:inline-block;width:160px;max-width:30vw;height:10px;margin-right:8px;vertical-align:middle;background:var(--icpc-soft);border:1px solid var(--icpc-line);border-radius:4px;overflow:hidden}
.icpc-hist-fill{display:block;height:100%;background:var(--icpc-accent)}
.icpc-hist-unknown{color:var(--icpc-muted)}
.icpc-hist-unknown .icpc-hist-fill{background:#b05532}
.icpc-viewswitch{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}
.icpc-viewswitch button[aria-pressed=true]{background:var(--icpc-accent);border-color:var(--icpc-accent);color:#fff;font-weight:650}
.icpc-diagnosis{margin:10px 0 0;padding-left:18px;color:var(--icpc-muted);font-size:12px}
.icpc-diagnosis li+li{margin-top:4px}
.icpc-coverage{margin:0 0 18px;padding:12px 16px;border:1px solid var(--icpc-line);border-radius:9px;background:var(--icpc-card)}
.icpc-coverage>summary{cursor:pointer;font-weight:600;padding:4px 0;color:var(--icpc-ink)}
.icpc-coverage[open]>summary{margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--icpc-line)}
.icpc-coverage .icpc-actions{margin-top:12px}
@media(max-width:640px){.icpc-hist-bar{width:110px;max-width:26vw}}
@media(prefers-color-scheme:dark){.icpc-root .icpc-viewswitch button[aria-pressed=true]{color:#17221f}.icpc-hist-unknown .icpc-hist-fill{background:#e9a184}}
.icpc-add-account{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;align-items:start;padding:16px 28px;background:var(--icpc-soft);border-bottom:1px solid var(--icpc-line)}
.icpc-add-account .icpc-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.icpc-add-account .icpc-field-help,.icpc-add-account .icpc-form-note,.icpc-add-account .icpc-field-example{margin:0;font-size:12px;color:var(--icpc-muted);line-height:1.55}
.icpc-add-account .icpc-field-example{overflow-wrap:anywhere}
.icpc-add-account .icpc-field-error{margin:0;font-size:12px;font-weight:600;color:#b05532}
.icpc-add-account .icpc-actions{display:flex;flex-direction:row;gap:8px;align-items:center;margin-top:2px}
.icpc-add-account input[aria-invalid=true]{border-color:#b05532}
@media(max-width:640px){.icpc-add-account{grid-template-columns:1fr;padding:14px 18px}}
@media(prefers-color-scheme:dark){.icpc-root .icpc-add-account .icpc-field-error{color:#e9a184}.icpc-root .icpc-add-account input[aria-invalid=true]{border-color:#e9a184}}
.icpc-viewswitch .icpc-muted{flex:1 1 220px;align-self:center;min-width:0;font-size:12px}
.icpc-merged-accounts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:14px 0;min-width:0}
.icpc-merged-account{min-width:0}
.icpc-merged-members,.icpc-merged-evidence{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.icpc-merged-members li{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0;overflow-wrap:anywhere}
.icpc-merged-evidence{margin-top:6px}
.icpc-merged-evidence li{overflow-wrap:anywhere}
.icpc-merged-evidence small{display:block}
.icpc-merged-rules{margin-top:14px}
.icpc-merged-rules p{overflow-wrap:anywhere}
.icpc-merged-detail{margin-top:16px}
@media(max-width:640px){.icpc-merged-accounts{grid-template-columns:1fr}.icpc-merged-members li{flex-direction:column;gap:2px}}
.icpc-root .icpc-viewswitch button[aria-pressed=true]{background:var(--icpc-accent);border-color:var(--icpc-accent);color:var(--icpc-card)}
.icpc-history-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:12px 0}
.icpc-history-card{border:1px solid var(--icpc-line);border-radius:8px;padding:14px;background:var(--icpc-card);min-width:0}
.icpc-history-card:first-child{border-color:var(--icpc-accent);background:var(--icpc-soft)}
.icpc-history-value{display:block;font-size:20px;margin:8px 0}
.icpc-history-card p{font-size:12px;overflow-wrap:anywhere}
.icpc-knowledge-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px}
.icpc-knowledge-summary>div{padding:12px 14px;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-card);min-width:0}
.icpc-knowledge-summary span{display:block;font-size:12px;color:var(--icpc-muted)}
.icpc-knowledge-summary strong{display:block;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.icpc-knowledge-summary small{display:block;overflow-wrap:anywhere}
.icpc-knowledge-dist{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.icpc-knowledge-dist button{display:flex;flex-direction:column;align-items:stretch;gap:4px;flex:1 1 150px;min-width:140px;text-align:left}
.icpc-knowledge-dist button[aria-pressed=true]{background:var(--icpc-accent);border-color:var(--icpc-accent);color:var(--icpc-card);font-weight:650}
.icpc-knowledge-dist-label{font-size:12px;overflow-wrap:anywhere}
.icpc-knowledge-dist strong{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.icpc-knowledge-meter{display:block;height:6px;border-radius:3px;background:var(--icpc-soft);overflow:hidden}
.icpc-knowledge-meter>span{display:block;height:100%;background:var(--icpc-accent)}
.icpc-knowledge-dist button[aria-pressed=true] .icpc-knowledge-meter{background:rgba(255,255,255,.3)}
.icpc-knowledge-dist button[aria-pressed=true] .icpc-knowledge-meter>span{background:var(--icpc-card)}
.icpc-knowledge-table{scroll-margin-top:12px;max-width:100%}
.icpc-knowledge-table:focus-visible{outline:3px solid #77b99c;outline-offset:2px}
.icpc-knowledge-table td{vertical-align:top;overflow-wrap:anywhere}
.icpc-knowledge-table td:first-child{min-width:150px}
.icpc-knowledge-table td span{display:block;font-size:12px}
.icpc-knowledge-name{font-weight:600;font-size:13px!important}
.icpc-knowledge-status{display:inline-block;padding:2px 8px;border-radius:4px;background:var(--icpc-soft);color:var(--icpc-accent);font-size:11px}
.icpc-knowledge-status-none{background:transparent;border:1px dashed var(--icpc-line);color:var(--icpc-muted)}
.icpc-knowledge-detail summary{font-size:12px}
.icpc-knowledge-band{min-width:180px;margin:8px 0;padding:8px;border:1px solid var(--icpc-line);border-radius:7px}
.icpc-knowledge-band button{font-size:12px;text-align:left;overflow-wrap:anywhere;width:100%;margin-bottom:4px}
.icpc-knowledge-band button[aria-pressed=true]{border-color:var(--icpc-accent);background:var(--icpc-soft)}
.icpc-knowledge-links{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.icpc-knowledge-links li{font-size:12px;overflow-wrap:anywhere}
.icpc-knowledge-sources{margin-top:18px;padding:12px 16px;border:1px solid var(--icpc-line);border-radius:9px;background:var(--icpc-card);font-size:12px;color:var(--icpc-muted)}
.icpc-knowledge-sources p{overflow-wrap:anywhere}
.icpc-knowledge-sources p+p{margin-top:8px}
@media(max-width:640px){.icpc-knowledge-dist button{flex-basis:calc(50% - 8px);min-width:0}.icpc-knowledge-table td:first-child{min-width:0}}
@media(prefers-color-scheme:dark){.icpc-root .icpc-knowledge-dist button[aria-pressed=true]{color:#17221f}.icpc-root .icpc-knowledge-dist button[aria-pressed=true] .icpc-knowledge-meter>span{background:#17221f}}
.icpc-tag-mapping td > span{display:block;overflow-wrap:anywhere}
.icpc-tag-mapping td .icpc-tag-mapping-refs{display:flex;flex-direction:column;gap:3px;margin-top:4px}
.icpc-tag-mapping td .icpc-tag-mapping-refs a{display:inline-block;font-size:12px;overflow-wrap:anywhere}
.icpc-plan-check{flex-direction:row;align-items:center;gap:6px}
.icpc-plan-check input{width:auto}
.icpc-plan-invalid{margin:8px 0 0;font-size:12px;font-weight:600;color:#b05532}
.icpc-plan-prepared{margin-top:14px;padding-top:12px;border-top:1px solid var(--icpc-line);min-width:0}
.icpc-plan-meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin:8px 0;font-size:12px;color:var(--icpc-muted);min-width:0;overflow-wrap:anywhere}
.icpc-plan-usage{font-variant-numeric:tabular-nums}
.icpc-plan-actions{display:flex;flex-wrap:wrap;gap:6px}
.icpc-plan-candidates{max-width:100%}
.icpc-plan-candidates td{vertical-align:top;overflow-wrap:anywhere}
.icpc-plan-candidates td:first-child{min-width:190px}
.icpc-plan-candidates td span{display:block;font-size:12px}
.icpc-plan-history{max-width:100%}
.icpc-plan-history td{vertical-align:top;overflow-wrap:anywhere}
.icpc-plan-history td span{display:block;font-size:12px}
.icpc-plan-history td.icpc-plan-usage{white-space:nowrap}
@media(max-width:640px){.icpc-plan-history td.icpc-plan-usage{white-space:normal}.icpc-plan-candidates td:first-child{min-width:0}}
@media(prefers-color-scheme:dark){.icpc-plan-invalid{color:#e9a184}}
/* Sprint 20b: the Luogu block is a compact section inside the import panel — a rule, not a second
   card — whose default view is a few status lines plus the primary action. Credentials, sync details,
   automatic-sync settings and advanced recovery each sit behind one native disclosure, and the long
   copy lives inside those, so the closed card stays short and still names every failure it has. */
.icpc-luogu{margin-top:14px;padding-top:12px;border-top:1px solid var(--icpc-line);min-width:0}
.icpc-luogu>summary{cursor:pointer;font-weight:600;padding:4px 0;color:var(--icpc-ink)}
.icpc-luogu[open]>summary{margin-bottom:10px}
.icpc-luogu-status{margin:0;overflow-wrap:anywhere}
.icpc-luogu-status strong{font-weight:650}
.icpc-luogu-alert{margin:0;padding:8px 10px;border-left:3px solid #b05532;border-radius:0 6px 6px 0;background:var(--icpc-soft);overflow-wrap:anywhere}
.icpc-luogu .icpc-check{flex-direction:row;align-items:center;gap:6px}
.icpc-luogu-credentials{margin-top:12px;padding:12px;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-soft);min-width:0}
.icpc-luogu-credentials form{display:flex;flex-direction:column;gap:8px;min-width:0}
.icpc-luogu-detail{margin-top:10px;min-width:0}
.icpc-luogu-detail>summary{cursor:pointer;font-weight:600;color:var(--icpc-ink)}
.icpc-luogu-detail-body{display:flex;flex-direction:column;gap:8px;padding:10px 0 2px;min-width:0}
.icpc-luogu-detail-body p,.icpc-luogu-detail-body small,.icpc-luogu-detail-body label{overflow-wrap:anywhere}
.icpc-luogu-detail-body label{font-size:12px}
.icpc-luogu .icpc-actions{flex-wrap:wrap}
.icpc-luogu .icpc-luogu-guide{font-size:12px;color:var(--icpc-muted);min-width:0}
.icpc-luogu .icpc-luogu-guide summary{cursor:pointer;color:var(--icpc-ink)}
.icpc-luogu .icpc-luogu-guide ol{margin:8px 0 0;padding-left:18px}
.icpc-luogu .icpc-luogu-guide li+li{margin-top:4px}
.icpc-luogu .icpc-luogu-guide p{margin-top:8px}
.icpc-luogu .icpc-field-error{font-size:12px;font-weight:600;color:#b05532}
@media(max-width:640px){.icpc-luogu{padding-top:10px}.icpc-luogu-credentials{padding:10px}}
@media(prefers-color-scheme:dark){.icpc-root .icpc-luogu .icpc-field-error{color:#e9a184}.icpc-root .icpc-luogu-alert{border-left-color:#e9a184}}
/* Sprint 20a: dedicated accounts & sync page. Nav wraps instead of scrolling once it has one more
   entry; every account rule stays inside .icpc-accounts or .icpc-sync-link under .icpc-root. */
.icpc-root .icpc-nav{flex-wrap:wrap}
.icpc-accounts{display:flex;flex-direction:column;gap:16px;min-width:0}
.icpc-account-list{list-style:none;margin:0 0 12px;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;min-width:0}
.icpc-account-list li{min-width:0}
.icpc-account-list button{display:flex;flex-direction:column;align-items:flex-start;gap:3px;width:100%;text-align:left;overflow-wrap:anywhere}
.icpc-account-list button[aria-pressed=true]{border-color:var(--icpc-accent);background:var(--icpc-soft);font-weight:650}
.icpc-account-list span{font-size:12px;color:var(--icpc-muted)}
.icpc-account-list button[aria-pressed=true] span{color:inherit}
.icpc-account-current{font-size:12px;color:var(--icpc-muted);overflow-wrap:anywhere}
.icpc-accounts .icpc-add-account{margin-top:14px;padding:14px 16px;border:1px solid var(--icpc-line);border-radius:9px;background:var(--icpc-soft)}
.icpc-account-guide{font-size:12px;color:var(--icpc-muted);min-width:0}
.icpc-account-guide summary{cursor:pointer;color:var(--icpc-ink)}
.icpc-account-guide p{margin-top:6px}
.icpc-accounts-source{display:flex;flex-direction:column;gap:12px;min-width:0}
.icpc-accounts-source .icpc-toolbar{margin-bottom:0;align-items:center}
.icpc-accounts-source .icpc-toolbar .icpc-muted{flex:1 1 240px;min-width:0;font-size:12px;overflow-wrap:anywhere}
.icpc-sync-link{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:16px}
.icpc-sync-link .icpc-muted{flex:1 1 220px;min-width:0;font-size:12px;overflow-wrap:anywhere}
@media(max-width:640px){.icpc-account-list{grid-template-columns:1fr}.icpc-accounts-source .icpc-toolbar>label{flex-basis:100%}}
/* Sprint 23b: per-problem and bulk completion editing. The editor is a normal inline section; the
   bank scrolls it into view, so it never becomes an off-screen form without a cue. */
.icpc-completion-summary{margin-top:14px;padding-top:12px;border-top:1px solid var(--icpc-line);min-width:0}
.icpc-completion-summary>h3{margin-bottom:6px}
.icpc-completion-editor{margin-top:16px;padding:14px 16px;border:1px solid var(--icpc-line);border-radius:9px;background:var(--icpc-soft);min-width:0;display:flex;flex-direction:column;gap:10px}
.icpc-completion-editor h3,.icpc-completion-editor h4{margin:0}
.icpc-completion-editor fieldset{display:flex;flex-direction:column;gap:9px;min-width:0;border:1px solid var(--icpc-line);border-radius:8px;padding:10px 12px;margin:0}
.icpc-completion-editor legend{padding:0 6px;color:var(--icpc-muted);font-size:12px}
.icpc-knowledge-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px;max-height:15rem;overflow:auto;padding:6px;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-card)}
.icpc-knowledge-list .icpc-check{flex-direction:row;align-items:center;gap:6px}
.icpc-completion-preview{margin-top:8px;display:flex;flex-direction:column;gap:8px;min-width:0}
.icpc-completion-editor-anchor{margin-top:16px}
.icpc-retro-form{margin-top:14px;padding-top:12px;border-top:1px solid var(--icpc-line);min-width:0}
.icpc-retro-form>summary{cursor:pointer;font-weight:600;padding:4px 0;color:var(--icpc-ink)}
.icpc-retro-form form{display:flex;flex-direction:column;gap:9px;margin-top:10px;min-width:0}
@media(max-width:640px){.icpc-knowledge-list{grid-template-columns:1fr}}
${katexCss}
/* Sprint 24a: locally rendered Markdown. Every rule is scoped under .icpc-markdown, so the app's own
   headings, tables and forms keep their existing look. KaTeX ships above this block and supplies the
   math layout plus the offline @font-face rules the build inlined; nothing is loaded from a CDN. */
.icpc-markdown{min-width:0;overflow-wrap:anywhere;white-space:normal}
.icpc-markdown h1,.icpc-markdown h2,.icpc-markdown h3,.icpc-markdown h4,.icpc-markdown h5,.icpc-markdown h6{margin:16px 0 8px;line-height:1.35;font-weight:650}
.icpc-markdown h1{font-size:21px}
.icpc-markdown h2{font-size:18px}
.icpc-markdown h3{font-size:16px}
.icpc-markdown h4,.icpc-markdown h5,.icpc-markdown h6{font-size:14px}
.icpc-markdown h1:first-child,.icpc-markdown h2:first-child,.icpc-markdown h3:first-child,.icpc-markdown p:first-child{margin-top:0}
.icpc-markdown p{margin:8px 0}
.icpc-markdown ul,.icpc-markdown ol{margin:8px 0;padding-left:24px}
.icpc-markdown li{margin:3px 0}
.icpc-markdown li>ul,.icpc-markdown li>ol{margin:3px 0}
.icpc-markdown ul.contains-task-list{padding-left:6px}
.icpc-markdown li.task-list-item{list-style:none}
.icpc-markdown input[type=checkbox]{width:auto;margin:0 6px 0 0;vertical-align:middle;accent-color:var(--icpc-accent)}
.icpc-markdown blockquote{margin:10px 0;padding:6px 12px;border-left:3px solid var(--icpc-line);background:var(--icpc-soft);color:var(--icpc-muted)}
.icpc-markdown hr{margin:14px 0;border:0;border-top:1px solid var(--icpc-line)}
.icpc-markdown del{color:var(--icpc-muted)}
.icpc-markdown code{font-family:Consolas,'Cascadia Mono','Courier New',monospace;font-size:12.5px;background:var(--icpc-soft);border:1px solid var(--icpc-line);border-radius:4px;padding:0 4px;overflow-wrap:anywhere}
.icpc-markdown .icpc-code{margin:10px 0;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-card);overflow:hidden}
.icpc-markdown .icpc-code-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 8px 4px 12px;border-bottom:1px solid var(--icpc-line);background:var(--icpc-soft);font-size:12px;color:var(--icpc-muted)}
.icpc-markdown .icpc-code-copy{padding:3px 8px;font-size:12px}
.icpc-markdown .icpc-code pre{margin:0;padding:12px;overflow:auto;max-height:32rem}
.icpc-markdown .icpc-code code{display:block;background:none;border:0;border-radius:0;padding:0;font-size:12.5px;line-height:1.55;white-space:pre}
.icpc-markdown .hljs-keyword,.icpc-markdown .hljs-selector-tag,.icpc-markdown .hljs-literal,.icpc-markdown .hljs-built_in{color:#8a3b7d}
.icpc-markdown .hljs-string,.icpc-markdown .hljs-attr,.icpc-markdown .hljs-regexp{color:#146c58}
.icpc-markdown .hljs-number,.icpc-markdown .hljs-symbol,.icpc-markdown .hljs-meta{color:#a15a1c}
.icpc-markdown .hljs-comment,.icpc-markdown .hljs-quote{color:var(--icpc-muted);font-style:italic}
.icpc-markdown .hljs-title,.icpc-markdown .hljs-function,.icpc-markdown .hljs-section{color:#1f5aa8}
.icpc-markdown .hljs-type,.icpc-markdown .hljs-class{color:#8a5a00}
.icpc-markdown table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse;margin:10px 0}
.icpc-markdown th,.icpc-markdown td{border:1px solid var(--icpc-line);padding:5px 10px;text-align:left;vertical-align:top}
.icpc-markdown th{background:var(--icpc-soft);font-weight:650}
.icpc-markdown img{max-width:100%;height:auto;border-radius:6px}
.icpc-markdown-image-fallback{display:inline-block;max-width:100%;padding:2px 8px;border:1px dashed var(--icpc-line);border-radius:5px;color:var(--icpc-muted);font-size:12px;overflow-wrap:anywhere}
.icpc-markdown-blocked-link{border-bottom:1px dotted var(--icpc-muted);color:var(--icpc-muted);cursor:help}
.icpc-markdown .katex-display{margin:10px 0;padding:4px 0;overflow-x:auto;overflow-y:hidden}
.icpc-markdown .katex{font-size:1.05em}
.icpc-markdown .katex-error{color:#b05532;overflow-wrap:anywhere;white-space:normal}
.icpc-markdown-oversize{margin:8px 0;padding:8px 12px;border-left:3px solid #b05532;border-radius:0 6px 6px 0;background:var(--icpc-soft)}
.icpc-markdown-source{margin-top:10px;font-size:12px;color:var(--icpc-muted)}
.icpc-markdown-source>summary{cursor:pointer;font-weight:600;color:var(--icpc-ink)}
.icpc-markdown-raw{margin:8px 0 0;padding:10px 12px;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-card);color:var(--icpc-ink);white-space:pre-wrap;overflow-wrap:anywhere;max-height:26rem;overflow:auto;font-size:12.5px}
@media(prefers-color-scheme:dark){.icpc-root .icpc-markdown .hljs-keyword,.icpc-root .icpc-markdown .hljs-selector-tag,.icpc-root .icpc-markdown .hljs-literal,.icpc-root .icpc-markdown .hljs-built_in{color:#e3a6d8}.icpc-root .icpc-markdown .hljs-string,.icpc-root .icpc-markdown .hljs-attr,.icpc-root .icpc-markdown .hljs-regexp{color:#83cdb1}.icpc-root .icpc-markdown .hljs-number,.icpc-root .icpc-markdown .hljs-symbol,.icpc-root .icpc-markdown .hljs-meta{color:#e9b184}.icpc-root .icpc-markdown .hljs-title,.icpc-root .icpc-markdown .hljs-function,.icpc-root .icpc-markdown .hljs-section{color:#9dc2f0}.icpc-root .icpc-markdown .hljs-type,.icpc-root .icpc-markdown .hljs-class{color:#e5cf8f}.icpc-root .icpc-markdown .katex-error{color:#e9a184}}
/* Sprint 24b: Luogu Markdown extensions. The scope is unchanged — nothing here can affect the app's
   own headings, tables or forms — and every rule targets a fixed class produced by
   src/ui/markdown/extensions.ts, because directive attributes are never forwarded to the DOM. */
.icpc-markdown .icpc-md-fold{margin:10px 0;padding:0 12px 2px;border:1px solid var(--icpc-line);border-left-width:3px;border-radius:8px;background:var(--icpc-card)}
.icpc-markdown .icpc-md-fold>summary{cursor:pointer;margin:0 -12px;padding:6px 12px;font-weight:650;color:var(--icpc-ink)}
.icpc-markdown .icpc-md-fold[open]>summary{margin-bottom:2px;border-bottom:1px solid var(--icpc-line)}
.icpc-markdown .icpc-md-fold-info{border-left-color:#3b6ea5}
.icpc-markdown .icpc-md-fold-success{border-left-color:#2f7a4f}
.icpc-markdown .icpc-md-fold-warning{border-left-color:#a5761c}
.icpc-markdown .icpc-md-fold-error{border-left-color:#b05532}
.icpc-markdown .icpc-md-fold>p:last-child,.icpc-markdown .icpc-md-fold>ul:last-child,.icpc-markdown .icpc-md-fold>ol:last-child{margin-bottom:8px}
.icpc-markdown .icpc-md-align{margin:8px 0}
.icpc-markdown .icpc-md-align-center{text-align:center}
.icpc-markdown .icpc-md-align-right{text-align:right}
.icpc-markdown .icpc-md-epigraph{background:var(--icpc-soft)}
.icpc-markdown .icpc-md-epigraph-author{display:block;margin:4px 0 0;text-align:right;font-size:12px;color:var(--icpc-muted);font-style:italic}
.icpc-markdown .icpc-md-epigraph-author::before{content:'—— '}
.icpc-markdown .icpc-md-cute-table{margin:10px 0}
.icpc-markdown .icpc-md-cute-table table{margin:0;border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px var(--icpc-line)}
.icpc-markdown .icpc-md-cute-table tr:nth-child(even) td{background:var(--icpc-soft)}
.icpc-markdown .icpc-md-unknown-directive{margin:8px 0;padding:6px 10px;border:1px dashed var(--icpc-line);border-radius:8px}
.icpc-markdown .icpc-md-unknown-marker{margin:0 0 6px;font-family:Consolas,'Cascadia Mono','Courier New',monospace;font-size:12px;color:var(--icpc-muted)}
.icpc-markdown td[rowspan],.icpc-markdown td[colspan],.icpc-markdown th[rowspan],.icpc-markdown th[colspan]{background:var(--icpc-soft)}
.icpc-markdown .icpc-code-numbered pre{display:flex;align-items:stretch}
.icpc-markdown .icpc-code-gutter{flex:0 0 auto;margin:0 8px 0 0;padding-right:8px;border-right:1px solid var(--icpc-line);color:var(--icpc-muted);font-family:Consolas,'Cascadia Mono','Courier New',monospace;font-size:12.5px;line-height:1.55;text-align:right;white-space:pre;user-select:none}
.icpc-markdown .icpc-code-numbered code{flex:1 1 auto;min-width:0}
.icpc-markdown .icpc-code code.icpc-code-lines{white-space:normal}
.icpc-markdown .icpc-code-line{display:block;white-space:pre}
.icpc-markdown .icpc-code-line-active{background:var(--icpc-soft);box-shadow:inset 2px 0 0 var(--icpc-accent)}
.icpc-markdown .icpc-markdown-video-link{display:inline-block;padding:4px 10px;border:1px solid var(--icpc-line);border-radius:6px;background:var(--icpc-soft);color:var(--icpc-accent);text-decoration:none;font-size:13px}
@media(prefers-color-scheme:dark){.icpc-root .icpc-markdown .icpc-code-line-active{background:#2a3444}}
/* Sprint 25b: the Luogu metadata backlog and its one manual-supplement form. The list is a normal
   bordered list of one-li-per-key rows (never hundreds of textareas), and the pager reuses the
   existing .icpc-pager rules; only the row, form and select sizing are new. */
.icpc-luogu-backlog{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;min-width:0}
.icpc-luogu-backlog>li{padding:10px 12px;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-card);min-width:0;display:flex;flex-direction:column;gap:6px}
.icpc-luogu-backlog-title{font-weight:650;overflow-wrap:anywhere}
.icpc-luogu-backlog-meta{font-size:12px;color:var(--icpc-muted);overflow-wrap:anywhere}
.icpc-luogu-backlog-issue{margin:0;font-size:12px;overflow-wrap:anywhere}
.icpc-luogu-backlog-row-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.icpc-luogu-backlog-pager{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.icpc-luogu-backlog-pager select{width:auto;min-width:84px}
.icpc-luogu-supplement{margin-top:6px;padding:10px 12px;border:1px solid var(--icpc-line);border-radius:8px;background:var(--icpc-soft);display:flex;flex-direction:column;gap:8px;min-width:0}
.icpc-luogu-supplement form{display:flex;flex-direction:column;gap:8px;min-width:0}
@media(max-width:640px){.icpc-luogu-backlog>li{padding:8px 10px}.icpc-luogu-backlog-pager span.icpc-muted{margin-left:0}}
/* Sprint 29b: one shared selection bar above (sticky) and below the table. Only the bank selection
   classes are touched; the sticky copy lives inside the ICPC scroll root, keeps an opaque background
   so rows pass underneath it, and the editor/results scroll-margins keep content below it. */
.icpc-selection-bar{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:0 0 8px;padding:8px 0;background:var(--icpc-card);border-bottom:1px solid var(--icpc-line)}
.icpc-selection-bar-bottom{position:static;margin:8px 0 0;padding-bottom:0;border-bottom:0;border-top:1px solid var(--icpc-line)}
.icpc-selection-count{font-variant-numeric:tabular-nums;white-space:nowrap}
.icpc-selection-scope,.icpc-selection-notice,.icpc-selection-blockers{flex:1 1 260px;min-width:0;font-size:12px;overflow-wrap:anywhere}
.icpc-selection-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.icpc-completion-editor-anchor{scroll-margin-top:88px}
.icpc-bank-table{scroll-margin-top:88px}
@media(max-width:900px){.icpc-selection-actions{width:100%}.icpc-selection-count{white-space:normal}}
@media(max-width:640px){.icpc-completion-editor-anchor,.icpc-bank-table{scroll-margin-top:150px}}
/* Sprint 29c: the completion editor keeps its controls reachable. The current-record table and the
   per-problem preview table are native disclosures: a bulk scope (up to 100 keys) shows one summary
   line with counts instead of 100 rows, so the mode select and the preview/apply/close buttons stay
   near the top; a one-problem scope opens its single row. Presentation only — no state or request
   rule is involved. Only the two new classes are selected, so other tables are untouched. */
.icpc-completion-records,.icpc-completion-preview-rows{min-width:0}
.icpc-completion-records>summary,.icpc-completion-preview-rows>summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--icpc-ink);padding:4px 0;overflow-wrap:anywhere}
.icpc-completion-records[open]>summary,.icpc-completion-preview-rows[open]>summary{margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--icpc-line)}
.icpc-completion-records .icpc-table-wrap,.icpc-completion-preview-rows .icpc-table-wrap{margin-top:8px}
`;
