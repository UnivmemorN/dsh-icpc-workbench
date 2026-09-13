/** Scoped workbench styles; host navigation and global reset remain owned by dsh. */
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
.icpc-luogu{margin-top:14px;padding:12px 14px;border:1px solid var(--icpc-line);border-radius:9px;background:var(--icpc-card)}
.icpc-luogu>summary{cursor:pointer;font-weight:600;padding:4px 0;color:var(--icpc-ink)}
.icpc-luogu[open]>summary{margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--icpc-line)}
.icpc-luogu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:12px;min-width:0}
.icpc-luogu-block{display:flex;flex-direction:column;gap:8px;min-width:0}
.icpc-luogu-block>p,.icpc-luogu-block>small{overflow-wrap:anywhere}
.icpc-luogu-block>label{font-size:12px}
.icpc-luogu .icpc-luogu-guide{font-size:12px;color:var(--icpc-muted);min-width:0}
.icpc-luogu .icpc-luogu-guide summary{cursor:pointer;color:var(--icpc-ink)}
.icpc-luogu .icpc-luogu-guide ol{margin:8px 0 0;padding-left:18px}
.icpc-luogu .icpc-luogu-guide li+li{margin-top:4px}
.icpc-luogu .icpc-luogu-guide p{margin-top:8px}
.icpc-luogu .icpc-field-error{font-size:12px;font-weight:600;color:#b05532}
@media(max-width:640px){.icpc-luogu{padding:10px 12px}.icpc-luogu-grid{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){.icpc-root .icpc-luogu .icpc-field-error{color:#e9a184}}
`;
