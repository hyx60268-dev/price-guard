import ExcelJS from 'exceljs';

export async function makeWorkbook(result,path){
  const wb=new ExcelJS.Workbook();
  const ws=wb.addWorksheet('价格与利润预警',{views:[{state:'frozen',ySplit:1,xSplit:3}]});
  ws.columns=[
    ['账号','accountName',14],['序号','seq',7],['商品名','title',42],['当前售价','ownPrice',12],['Yahoo最低价','lowestPrice',14],
    ['建议价','recommendedPrice',12],['闲鱼参考均价(元)','averageCNY',16],['人工确认采购价(元)','manualPurchaseCNY',18],
    ['人肉费(元)','manualFeeCNY',13],['日本物流费(日元)','shippingJPY',16],['成本(日元)','costJPY',13],
    ['当前利润','currentProfitJPY',13],['调价后利润','afterProfitJPY',14],['预警','advice',22],['置信度','confidence',10],
    ['Yahoo来源','yahooSource',12],['成本来源','costSource',12],['Yahoo商品','ownUrl',36],['最低价链接','lowestUrl',36],['闲鱼搜索','xianyuSearchUrl',36],
    ['在售至少天数','listingDays',16],['时间依据','listingAgeSource',22],['30天未售建议','listingAgeAdvice',48]
  ].map(([header,key,width])=>({header,key,width}));
  ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17365D'}};
  for(const source of result.items){
    const row=ws.addRow({...source,
      listingDays:source.listingAge?.days??null,listingAgeSource:source.listingAge?.source==='platform_open_date'?'平台上架日期':source.listingAge?.source==='first_observed'?'系统首次确认在售':'待确认',listingAgeAdvice:source.listingAge?.message||'',
      manualPurchaseCNY:source.manualPurchaseCNY??source.manualCost?.purchaseCNY??null,
      manualFeeCNY:source.manualFeeCNY??source.manualCost?.manualFeeCNY??null,
      shippingJPY:source.shippingJPY??source.manualCost?.shippingJPY??null
    });
    const n=row.number;
    row.getCell('K').value={formula:`IF(OR(AND(G${n}="",H${n}=""),I${n}="",J${n}=""),"",ROUNDUP(((IF(H${n}="",G${n},H${n})+I${n})*参数!$B$2+J${n})*参数!$B$4,0))`,result:source.costJPY??undefined};
    row.getCell('L').value={formula:`IF(K${n}="","",D${n}-K${n})`,result:source.currentProfitJPY??undefined};
    row.getCell('M').value={formula:`IF(K${n}="","",F${n}-K${n})`,result:source.afterProfitJPY??undefined};
    row.getCell('N').value={formula:`IF(K${n}="","待输入成本",IF(M${n}<0,"调价后亏损",IF(M${n}<参数!$B$3,"不建议按推荐价出售",IF(L${n}<参数!$B$3,"建议提价或控制成本","利润正常"))))`,result:source.advice??'待输入成本'};
  }
  ws.autoFilter={from:'A1',to:'T1'};
  for(const key of ['ownPrice','lowestPrice','recommendedPrice','costJPY','currentProfitJPY','afterProfitJPY'])ws.getColumn(key).numFmt='¥#,##0;[Red]-¥#,##0';
  for(const key of ['averageCNY','manualPurchaseCNY','manualFeeCNY'])ws.getColumn(key).numFmt='¥0.00';
  ws.getColumn('shippingJPY').numFmt='¥#,##0';
  ws.getColumn('manualPurchaseCNY').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}};
  ws.getColumn('manualFeeCNY').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}};
  ws.getColumn('shippingJPY').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}};

  const ac=wb.addWorksheet('账号状态');
  ac.columns=[{header:'账号',key:'name',width:18},{header:'主页',key:'profileUrl',width:48},{header:'主页状态',key:'profileStatus',width:16},{header:'商品数',key:'itemCount',width:10},{header:'错误',key:'profileError',width:50}];
  for(const account of result.accounts||[])ac.addRow(account);

  const info=wb.addWorksheet('参数');
  info.addRows([
    ['检查时间',result.checkedAt],
    ['人民币兑日元',result.settings.exchangeRate],
    ['利润预警(日元)',result.settings.profitWarningJPY],
    ['成本系数',result.settings.costMultiplier],
    ['成本公式','((人工确认采购价 + 人肉费) × 汇率 + 日本物流费) × 成本系数，向上取整'],
    ['填写说明','黄色三列由你填写；系统不再按尺寸猜测费用。']
  ]);
  info.columns=[{width:24},{width:78}];
  await wb.xlsx.writeFile(path);
}
