"""Offline Harris + multi-scale normalized patch + affine RANSAC appearance probe.
No pretrained model; not SIFT and not product identity verification.
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, maximum_filter, map_coordinates
from scipy.spatial.distance import cdist
import json,time
ROOT=Path(__file__).parent

def extract(path):
    im=Image.open(path).convert('RGB'); im.thumbnail((480,480)); rgb=np.asarray(im,dtype=float)/255
    g=np.asarray(im.convert('L'),dtype=float)/255
    y=gaussian_filter(g,1,order=[1,0]);x=gaussian_filter(g,1,order=[0,1])
    a=gaussian_filter(x*x,1.6);b=gaussian_filter(y*y,1.6);c=gaussian_filter(x*y,1.6)
    h=a*b-c*c-.04*(a+b)**2
    mask=(h==maximum_filter(h,9))&(h>h.max()*.002)
    mask[:20]=False;mask[-20:]=False;mask[:,:20]=False;mask[:,-20:]=False
    yy,xx=np.nonzero(mask);order=np.argsort(h[yy,xx])[::-1][:500];pts=np.stack([xx[order],yy[order]],axis=1)
    features=[];points=[];scales=[]
    for width in [16,22,30,42,58]:
        smooth=gaussian_filter(g,max(.5,width/24))
        grid=np.linspace(-width/2,width/2,8);gy,gx=np.meshgrid(grid,grid,indexing='ij')
        for p in pts:
            if min(p[0],p[1],g.shape[1]-p[0],g.shape[0]-p[1]) < width/2:continue
            v=map_coordinates(smooth,[gy+p[1],gx+p[0]],order=1).ravel();v-=v.mean();norm=np.linalg.norm(v)
            if norm<.12:continue
            features.append(v/norm);points.append(p);scales.append(width)
    return {'im':im,'g':g,'rgb':rgb,'pts':np.array(points),'desc':np.array(features),'scales':np.array(scales)}

def compare(a,b,seed=42):
    if not len(a['desc']) or not len(b['desc']):
        return {'tentative':0,'inliers':0,'inlier_fraction':0.,'source_hull_bbox_fraction':0.,'target_hull_bbox_fraction':0.,'aligned_rgb_mae':None,'affine':None},[]
    d=cdist(a['desc'],b['desc']);matches=[]
    # Ratio to second distinct location, not a descriptor of the same keypoint.
    for i,row in enumerate(d):
        order=np.argsort(row);j=order[0]
        second=next((k for k in order[1:] if np.linalg.norm(b['pts'][k]-b['pts'][j])>8),None)
        if second is not None and row[j]<.75*row[second] and row[j]<.72:
            matches.append((i,j,float(row[j])))
    matches.sort(key=lambda p:p[2]);uniq=[];useda=[];usedb=[]
    for i,j,dst in matches:
        if any(np.linalg.norm(a['pts'][i]-p)<8 for p in useda) or any(np.linalg.norm(b['pts'][j]-p)<8 for p in usedb): continue
        uniq.append((i,j,dst));useda.append(a['pts'][i]);usedb.append(b['pts'][j])
    n=len(uniq);out={'tentative':n,'inliers':0,'inlier_fraction':0.,'source_hull_bbox_fraction':0.,'target_hull_bbox_fraction':0.,'aligned_rgb_mae':None,'affine':None}
    if n<3:return out,[]
    src=np.array([a['pts'][i] for i,j,d in uniq]);dst=np.array([b['pts'][j] for i,j,d in uniq]);X=np.c_[src,np.ones(n)];rng=np.random.default_rng(seed);best=np.zeros(n,dtype=bool)
    for _ in range(1500):
        ix=rng.choice(n,3,replace=False)
        if abs(np.linalg.det(X[ix]))<25:continue
        M=np.linalg.solve(X[ix],dst[ix]);sing=np.linalg.svd(M[:2],compute_uv=False)
        if sing.min()<.35 or sing.max()>3 or sing.max()/sing.min()>1.8 or np.linalg.det(M[:2])<=0:continue
        good=np.linalg.norm(X@M-dst,axis=1)<4
        if good.sum()>best.sum():best=good
    if best.sum()<3:return out,[]
    M=np.linalg.lstsq(X[best],dst[best],rcond=None)[0];best=np.linalg.norm(X@M-dst,axis=1)<4
    out['inliers']=int(best.sum());out['inlier_fraction']=float(best.mean());out['affine']=M.tolist()
    for key,points,data in [('source_hull_bbox_fraction',src,a),('target_hull_bbox_fraction',dst,b)]:
        extent=np.ptp(points[best],axis=0);out[key]=float(np.prod(extent)/(data['g'].shape[0]*data['g'].shape[1]))
    yy,xx=np.indices(a['g'].shape);coords=np.c_[xx.ravel(),yy.ravel(),np.ones(xx.size)]@M
    valid=(coords[:,0]>=0)&(coords[:,0]<b['g'].shape[1]-1)&(coords[:,1]>=0)&(coords[:,1]<b['g'].shape[0]-1)
    # Ignore near-white pixels: matching blank background is weak evidence.
    valid &= ((a['rgb'].reshape(-1,3).min(axis=1)<.94))
    warped=np.stack([map_coordinates(b['rgb'][:,:,c],[coords[:,1],coords[:,0]],order=1,mode='nearest') for c in range(3)],axis=1)
    if valid.sum():out['aligned_rgb_mae']=float(abs(a['rgb'].reshape(-1,3)[valid]-warped[valid]).mean())
    out['aligned_pixel_fraction']=float(valid.mean())
    return out,[(src[k],dst[k]) for k in np.nonzero(best)[0]]

def draw(a,b,pairs,path):
    ia=a['im'];ib=b['im'];im=Image.new('RGB',(ia.width+ib.width,max(ia.height,ib.height)),'white');im.paste(ia);im.paste(ib,(ia.width,0));dr=ImageDraw.Draw(im)
    for pa,pb in pairs:dr.line((pa[0],pa[1],pb[0]+ia.width,pb[1]),fill=(255,40,40),width=1)
    im.save(path)

if __name__ == "__main__":
    start=time.perf_counter();data={n:extract(ROOT/(n+'.png')) for n in ['umbrella_own','umbrella_reference','apex_own','apex_reference']};rows=[]
    for na in ['umbrella_own','apex_own']:
        for nb in ['umbrella_reference','apex_reference']:
            t=time.perf_counter();out,pairs=compare(data[na],data[nb]);out.update(a=na,b=nb,seconds=time.perf_counter()-t);rows.append(out);draw(data[na],data[nb],pairs,ROOT/(na+'--'+nb+'.png'))
    result={'scope':'Historical screenshot crop geometry, no model, no market truth; 2 appearance positives + 2 same-character wrong-style controls only','method':'Harris multi-scale normalized 8x8 patches, nearest distinct-point ratio .75, affine RANSAC 4px; fixed settings across all four pairs','rows':rows,'seconds':time.perf_counter()-start}
    (ROOT/'geometry.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
