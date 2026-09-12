import ExcelJS from 'exceljs';

export async function makeWorkbook(result,path){
  const wb=new ExcelJS.Workbook(); const ws=wb.addWorksheet('价格与利润预警',{views:[{state:'frozen',ySplit:1,xSplit:2}]});
  ws.columns=[
    ['序号','seq',7],['商品名','title',42],['当前售价','ownPrice',12],['Yahoo最低价','lowestPrice',14],['建议价','recommendedPrice',12],
    ['闲鱼均价(元)','averageCNY',14],['成本(日元)','costJPY',13],['当前利润','currentProfitJPY',13],['调价后利润','afterProfitJPY',14],
    ['预警','advice',22],['置信度','confidence',10],['Yahoo商品','yahooUrl',36],['最低价链接','lowestUrl',36],['闲鱼搜索','xianyuSearchUrl',36]
  ].map(([header,key,width])=>({header,key,width}));
  ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}}; ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17365D'}};
  for(const row of result.items)ws.addRow(row);
  ws.autoFilter={from:'A1',to:'N1'};
  ws.getColumn('ownPrice').numFmt='¥#,##0'; ws.getColumn('lowestPrice').numFmt='¥#,##0'; ws.getColumn('recommendedPrice').numFmt='¥#,##0';
  ws.getColumn('costJPY').numFmt='¥#,##0'; ws.getColumn('currentProfitJPY').numFmt='¥#,##0;[Red]-¥#,##0'; ws.getColumn('afterProfitJPY').numFmt='¥#,##0;[Red]-¥#,##0';
  ws.eachRow((row,n)=>{if(n>1&&String(row.getCell(10).value).match(/亏损|不建议|控制成本/))row.getCell(10).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFCE4D6'}};});
  const info=wb.addWorksheet('参数');
  info.addRows([['检查时间',result.checkedAt],['人民币兑日元',result.settings.exchangeRate],['利润预警(日元)',result.settings.profitWarningJPY],['成本系数',result.settings.costMultiplier],['小件','+30元 / +210日元'],['中件','+50元 / +850日元'],['大件','+100元 / +1200日元']]);
  info.columns=[{width:22},{width:38}];
  await wb.xlsx.writeFile(path);
}
