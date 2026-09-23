// Read-only, targeted live checks. This is NOT a full inventory scan and does
// not update prices, costs, caches or published data. Run explicitly, not in CI.
import {fetchYahooItemBundle,yahooCompare} from './lib/yahoo.mjs';
const pairs=[
  ['melon','z688398956','z687200642','Fan Ho three books vs two'],
  ['local-1789214704376','z680530416','z687200642','Fan Ho three books vs two'],
  ['account-p6579087','z688147256','z687200642','Fan Ho three books vs two'],
  ['account-p6579087','z526102484','z685947642','Kitty black/gold vs beige/blue'],
  ['local-1789214704376','z676678004','z609388100','Giyu white-shirt vs haori bust'],
  ['melon','z682903842','z609388100','Giyu white-shirt vs haori bust']
];
const cache=new Map();
async function bundle(id){
  if(!cache.has(id))cache.set(id,await fetchYahooItemBundle(id,{}));
  return cache.get(id);
}
for(const [accountId,ownId,candidateId,label] of pairs){
  const own=await bundle(ownId),other=await bundle(candidateId),detail=own.detail,candidate=other.detail;
  const image=candidate.images?.[0]?.url;
  const card={id:candidate.id,title:candidate.title,price:Number(candidate.price),sellerId:candidate.seller?.id,
    image,source:'recommendation',recommendationType:'vector',recommendationScore:1};
  const item={id:ownId,accountId,title:detail.title,ownPrice:Number(detail.price),image:detail.images?.[0]?.url,
    yahoo:{searchCheckedAt:new Date().toISOString()}};
  const result=await yahooCompare(null,item,{maxYahooImages:3,maxYahooDetailChecks:1},{
    fetchYahooItemBundle:async id=>id===ownId?{...own,recommendations:[card]}:other,
    fetchYahooResult:async()=>({items:[]})
  });
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),accountId,label,ownId,candidateId,
    ownTitle:detail.title,candidateTitle:candidate.title,ownPrice:detail.price,candidatePrice:candidate.price,
    competitorCount:result.competitorCount,detailCheckedCount:result.detailCheckedCount,
    status:result.status,recommendedPrice:result.recommendedPrice,rejected:result.rejected}));
  if(result.competitorCount!==0)process.exitCode=1;
}
