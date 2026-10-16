# Native supplier quote ingress

`normalizeNativeSupplierDetail(item, observation, options)` is a normalization
boundary for a future public-detail adapter or reviewed import. It does not fetch
web pages, authenticate, discover products, or establish source authority. This
change does not add live Taobao, Dewu or Bilibili collection. No research price is
seeded into production inventory.

The user's procurement sources are Xianyu, Taobao, Dewu and Bilibili, with receipt
in China. China-to-Japan forwarding remains a separate manual expense. Province
is unknown; a published freight amount does not prove destination applicability.

## Input contract

The adapter must supply an actual readable HTTP 200 target-detail observation:
`source`, `finalUrl`, original `fetchedAt`, `httpStatus`, `pageKind: target_detail`,
`accessStatus: readable`, `contentSha256` of the observed body, and `detailTitle`.
The receipt URL is retained exactly, including identity query parameters; shortened
share links must first resolve through an allowed, readable public route. Host
allowlisting identifies the platform, not an official seller or a working adapter.
The normalized canonical product URL excludes tracking; product and URL-selected
SKU identifiers must agree with the detail evidence. Xianyu, Taobao/Tmall,
Youzan and ALTER routes are recognized. Bilibili/Dewu imports remain rejected
until an actual public detail URL contract is reviewed; a host is insufficient.
Login, CAPTCHA, HTTP 412 and other access restrictions stop collection.

`selectedOffer` must contain source `productId`, `skuId`, `sellerKey` (platform:id),
`sellerName`, selected variant, positive integer quantity, explicit sale contents,
positive `nativePrice`, explicit native `currency`, `priceEvidence`,
`currencyEvidence`, `priceKind: selected_sku_total`, `purchaseType: ordinary`,
`priceCondition: unconditional`, and an independently checked
`isOwn: false`. The amount is for the specified quantity, not inferred per-unit.
No range/starting price, coupon-dependent price, deposit, preorder commitment,
search-card price or the user's own selling price can populate this field.
The caller supplies `ownedSellerKeys` to reject all known managed suppliers.

Availability is `in_stock`, `out_of_stock` or `unknown`; condition is `new`, `used`
or `unknown`. Known states require their source text; unknown evidence is null.
Shipping is either all-null unknown fields with `destinationCountry: CN`, or
`published_terms` with amount, same currency, source text, published scope and
`applicability: unconfirmed`. Zero is valid only when explicitly observed.
Identity remains `pending` or `catalog_only` with evidence. These observations
cannot assert physical-offer eligibility or factory sealing.

## Storage and UI

Store normalized results in `item.nativeSupplierQuotes`. They bind the exact
account, listing, title, image, full description and condition. Original timestamps
and the body receipt survive JSON storage and publication. Future or >=24-hour
observations, changed targets, malformed receipts, owned sellers and rejected
matches are hidden. A failed refresh never changes an existing observation time.

The UI labels native amount/currency, quantity, variant, stock, condition,
published shipping and remaining evidence gaps. It explicitly states that the
quote is not counted in cost, profit or cycle completion. `chooseProcurementReference`
does not consume this field, including when every optional fact is filled in.
No FX conversion or delivered cost is synthesized.

Promotion requires a separate source-specific adapter and verified physical offer
identity, current payable selected-SKU price/stock and applicable domestic freight.
A reliable authoritative supplier may qualify on one actual offer; the legacy
multi-seller benchmark rule is not an authority substitute.
