import {violetReports} from './yahoo-violet-reports.mjs';

// Actual bounded production rejection evidence, not reconstructed sale prose.
// Run 38928891995 / slot 5 / job 117111312765, checked 2026-10-16T17:55:27.163Z.
export const violetQueueEvidence={
 source:'https://github.com/hyx60268-dev/price-guard/actions/runs/38928891995/job/117111312765',
 checkedAt:'2026-10-16T17:55:27.163Z',ownId:'z705310958',report:violetReports[1],
 cardCount:185,preliminaryCount:86,detailCheckedCount:8,competitorCount:0,uncheckedLowerCandidateCount:64,
 rejected:[
  ['z695864734',500,'physical_product_type_unconfirmed'],
  ['z702310278',500,'sale_description_unavailable'],
  ['z703459968',650,'physical_product_type_unconfirmed'],
  ['z695831578',880,'physical_product_type_unconfirmed'],
  ['z576172104',950,'physical_product_type_unconfirmed'],
  ['z702857538',1100,'physical_product_type_unconfirmed'],
  ['z694455184',1140,'physical_product_type_unconfirmed'],
  ['z674227538',1180,'physical_product_type_unconfirmed']
 ].map(([id,price,reason])=>({id,price,reason})),
 // The screenshot's umbrella rival ID has not been captured. Never identify
 // this controlled fixture ID as a real marketplace offer.
 controlledRivalId:'fixture-violet-umbrella-28000'
};
