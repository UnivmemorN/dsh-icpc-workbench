import type{Context}from'@deepseek-ai/cordis';
import type{}from'@deepseek-ai/dsh-client-ui-renderer/client';
import type{}from'@deepseek-ai/dsh-client-ui-layout/client';
import type{}from'@deepseek-ai/dsh-client-ui-sidebar/client';
import{createElement}from'react';import{App}from'./App.js';import{styles}from'./styles.js';
export const name='icpc-workbench-client';export const inject=['slots','layout'];
function Icon(){return createElement('svg',{width:20,height:20,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},createElement('path',{d:'M4 5h6v14H4zM14 5h6v14h-6zM7 9v6M17 9v6'}));}
export function apply(ctx:Context):void{
 ctx.effect(()=>{const style=document.createElement('style');style.dataset.icpcWorkbench='true';style.textContent=styles;document.head.append(style);return()=>style.remove();},'icpc-workbench: styles');
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'icpc-workbench'},()=>createElement(App,{onExit:()=>ctx.layout.selectPanel(null)})));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'icpc-workbench',order:40,label:'ICPC 训练'},Icon));
}