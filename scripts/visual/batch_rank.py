#!/usr/bin/env python3
"""Offline-only NDJSON worker; one process can serve multiple bounded batches.
Scores prioritize inspection only. Includes known repeated-background false positive.
No downloads, no network, no marketplace reads, no strict product acceptance.
"""
import argparse,base64,hashlib,io,json,os,re,sys,time,warnings,resource
from pathlib import Path
from collections import OrderedDict
from PIL import Image
from local_features import extract,compare
MAX_JSON=96*1024*1024
LIMITS={'images':32,'pairs':64,'image_bytes':12*1024*1024,'total_bytes':64*1024*1024,'decoded_pixels':16_000_000,'soft_deadline_seconds':30,'feature_cache_entries':32}
VERSION='harris_affine_rank_v1_offline'
Image.MAX_IMAGE_PIXELS=LIMITS['decoded_pixels']
CACHE=OrderedDict()
class BoundedError(Exception):pass

def bytes_for(item,root):
    if ('path' in item)==('base64' in item):raise BoundedError('exactly_one_local_source_required')
    if 'path' in item:
        p=(root/str(item['path'])).resolve()
        try:p.relative_to(root)
        except ValueError:raise BoundedError('outside_image_root')
        if not p.is_file():raise BoundedError('local_image_missing')
        if p.stat().st_size>LIMITS['image_bytes']:raise BoundedError('image_bytes_limit')
        data=p.read_bytes()
    else:
        raw=item['base64']
        if not isinstance(raw,str) or len(raw)>LIMITS['image_bytes']*4//3+4:raise BoundedError('image_bytes_limit')
        try:data=base64.b64decode(raw,validate=True)
        except Exception:raise BoundedError('invalid_base64')
    if not data or len(data)>LIMITS['image_bytes']:raise BoundedError('image_bytes_limit')
    return data

def process(batch,root):
    start=time.perf_counter();images=batch.get('images');pairs=batch.get('pairs')
    if not isinstance(images,list) or len(images)>LIMITS['images'] or not isinstance(pairs,list) or len(pairs)>LIMITS['pairs']:raise BoundedError('batch_shape_or_count_limit')
    found={};errors={};hashes={};total=0;hits=0;computed=0
    for item in images:
        if not isinstance(item,dict) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',str(item.get('id',''))):raise BoundedError('invalid_image_id')
        k=item['id']
        if k in found or k in errors:raise BoundedError('duplicate_image_id')
        if time.perf_counter()-start>LIMITS['soft_deadline_seconds']:errors[k]='soft_deadline';continue
        try:
            data=bytes_for(item,root);total+=len(data)
            if total>LIMITS['total_bytes']:raise BoundedError('batch_bytes_limit')
            sha=hashlib.sha256(data).hexdigest();hashes[k]=sha
            if sha in CACHE:found[k]=CACHE.pop(sha);CACHE[sha]=found[k];hits+=1;continue
            with warnings.catch_warnings():
                warnings.simplefilter('error',Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as im:
                    if im.width*im.height>LIMITS['decoded_pixels']:raise BoundedError('decoded_pixel_limit')
                    if im.width<32 or im.height<32:raise BoundedError('image_too_small')
                    im.verify()
                value=extract(io.BytesIO(data))
            if not len(value['desc']):errors[k]='no_visual_features';continue
            CACHE[sha]=value;found[k]=value;computed+=1
            while len(CACHE)>LIMITS['feature_cache_entries']:CACHE.popitem(last=False)
        except BoundedError as e:errors[k]=str(e)
        except Exception:errors[k]='decode_or_feature_error'
    feature_seconds=time.perf_counter()-start;rows=[]
    for pair in pairs:
        if not isinstance(pair,list) or len(pair)!=2 or not all(isinstance(x,str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',x) for x in pair):raise BoundedError('invalid_pair')
        a,b=pair;row={'queryId':a,'candidateId':b,'status':'unknown','rankHint':'unresolved','identityVerified':False,'canRecommend':False,'foregroundSupport':'unknown','coverageKind':'matched_keypoint_bounding_box_not_product_mask'}
        if time.perf_counter()-start>LIMITS['soft_deadline_seconds']:row['reason']='soft_deadline'
        elif a not in found or b not in found:row['reason']=errors.get(a) or errors.get(b) or 'image_not_supplied'
        else:
            t=time.perf_counter();o,_=compare(found[a],found[b]);row.update(status='visual_metrics_only',metrics={'tentativeMatches':o['tentative'],'inliers':o['inliers'],'inlierFraction':o['inlier_fraction'],'sourceCoverage':o['source_hull_bbox_fraction'],'targetCoverage':o['target_hull_bbox_fraction'],'alignedRgbMae':o['aligned_rgb_mae'],'alignedPixelFraction':o.get('aligned_pixel_fraction')},durationMs=round((time.perf_counter()-t)*1000,3),queryContentSha256=hashes[a],candidateContentSha256=hashes[b])
            # Exploratory routing only. Known false positives prohibit promotion to identity.
            if o['inliers']>=12 and o['inlier_fraction']>=.45 and min(o['source_hull_bbox_fraction'],o['target_hull_bbox_fraction'])>=.15 and o['aligned_rgb_mae'] is not None and o['aligned_rgb_mae']<=.15:row['rankHint']='same_artwork_candidate'
        rows.append(row)
    return {'version':VERSION,'scope':'candidate_ranking_only','knownLimitation':'Shared textured background can produce same_artwork_candidate for different products. No SKU, quantity, condition, stock, price or freshness is verified. Unresolved is not exclusion.','limits':LIMITS,'stats':{'imagesRequested':len(images),'featuresComputed':computed,'featureCacheHits':hits,'inputBytes':total,'featureSeconds':feature_seconds,'elapsedSeconds':time.perf_counter()-start,'peakRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024},'imageErrors':[{'id':k,'reason':v} for k,v in errors.items()],'pairs':rows}

def main():
    p=argparse.ArgumentParser();p.add_argument('--image-root',type=Path,required=True);args=p.parse_args();root=args.image_root.resolve()
    while True:
        line=sys.stdin.buffer.readline(MAX_JSON+1)
        if not line:break
        if len(line)>MAX_JSON:
            print(json.dumps({'status':'unknown','reason':'json_input_limit'}),flush=True);break
        try:result=process(json.loads(line),root)
        except BoundedError as e:result={'status':'unknown','reason':str(e)}
        except Exception:result={'status':'unknown','reason':'invalid_batch'}
        print(json.dumps(result,separators=(',',':')),flush=True)
if __name__=='__main__':main()
