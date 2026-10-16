"""Сборка клипа VK (1080x1920) из коллажа 3x3 по JSON-спецификации.

Запуск: python3 clipmaker.py week/<код>.json
Результат: clip_<код>.mp4 (~3 с на слайд, плавный зум, тихая аудиодорожка)
и превью clip_<код>_sheet.jpg рядом со спецификацией.
Зависимости: Pillow, numpy, ffmpeg, шрифты DejaVu.
"""
import sys, json, subprocess, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; R='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
W,H=1080,1920
def grid(img):
    a=np.asarray(img.convert('L')).astype(int)
    def bands(prof,n):
        white=prof>240; runs=[]; start=None
        for i,w in enumerate(white):
            if not w and start is None: start=i
            if w and start is not None:
                if i-start>n*0.15: runs.append((start,i))
                start=None
        if start is not None and n-start>n*0.15: runs.append((start,n))
        return runs
    return bands(a.mean(axis=1),a.shape[0]), bands(a.mean(axis=0),a.shape[1])
def tiles(img):
    rows,cols=grid(img)
    if len(rows)!=3 or len(cols)!=3:
        h,w=img.height,img.width
        rows=[(int(h*i/3)+4,int(h*(i+1)/3)-4) for i in range(3)]; cols=[(int(w*i/3)+4,int(w*(i+1)/3)-4) for i in range(3)]
    return [img.crop((c[0]+3,r[0]+3,c[1]-3,r[1]-3)) for r in rows for c in cols]
def wrap(d,text,font,maxw):
    lines=[];cur=''
    for w in text.split():
        t=(cur+' '+w).strip()
        if d.textlength(t,font=font)<=maxw: cur=t
        else: lines.append(cur);cur=w
    lines.append(cur);return lines
def slide(pic,top,bottom=None,num=None):
    bg=pic.resize((W,H),Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
    bg=Image.blend(bg,Image.new('RGB',(W,H),(30,22,14)),0.5)
    tw=920; th=int(pic.height*tw/pic.width)
    if th>1100: th=1100; tw=int(pic.width*th/pic.height)
    p=pic.resize((tw,th),Image.LANCZOS)
    m=Image.new('L',(tw,th),0); ImageDraw.Draw(m).rounded_rectangle([0,0,tw,th],40,fill=255)
    y0=520; bg.paste(p,((W-tw)//2,y0),m)
    d=ImageDraw.Draw(bg); y=170
    if num:
        f=ImageFont.truetype(B,64); r=62; cx=W//2
        d.ellipse([cx-r,y-10,cx+r,y-10+2*r],fill=(245,236,222))
        bb=d.textbbox((0,0),num,font=f); d.text((cx-(bb[2]-bb[0])/2-bb[0],y-10+r-(bb[3]-bb[1])/2-bb[1]),num,font=f,fill=(110,70,40)); y+=150
    f=ImageFont.truetype(B,64 if num else 76)
    for ln in wrap(d,top,f,960):
        tl=d.textlength(ln,font=f); d.text(((W-tl)/2,y),ln,font=f,fill=(255,248,238)); y+=86 if num else 98
    if bottom:
        f2=ImageFont.truetype(R,50); yb=y0+th+70
        for ln in wrap(d,bottom,f2,940):
            tl=d.textlength(ln,font=f2); d.text(((W-tl)/2,yb),ln,font=f2,fill=(245,232,214)); yb+=66
    return bg
def build(spec_path):
    spec=json.load(open(spec_path)); img=Image.open(spec['image']).convert('RGB'); T=tiles(img)
    out=os.path.dirname(spec_path) or '.'; name=spec['name']; files=[]
    for i,s in enumerate(spec['slides']):
        pic=img if s['tile']=='full' else img.crop((0,0,img.width//2,img.height)) if s['tile']=='left' else img.crop((img.width//2,0,img.width,img.height)) if s['tile']=='right' else T[s['tile']-1]
        fn=f"{out}/{name}_s{i}.jpg"; slide(pic,s['top'],s.get('bottom'),s.get('num')).save(fn,quality=95); files.append(fn)
    D=3.0; clips=[]
    for i,fn in enumerate(files):
        cf=f"{out}/{name}_c{i}.mp4"
        subprocess.run(['ffmpeg','-y','-loglevel','error','-loop','1','-i',fn,'-t',str(D),'-vf',"scale=2160:3840,zoompan=z='min(1+0.0006*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,format=yuv420p",'-c:v','libx264','-preset','medium','-crf','23',cf],check=True); clips.append(cf)
    args=[]; [args.extend(['-i',c]) for c in clips]; args+=['-f','lavfi','-i','anullsrc=r=44100:cl=stereo']
    F=[];prev='0:v'
    for i in range(1,len(clips)):
        F.append(f"[{prev}][{i}:v]xfade=transition=fade:duration=0.4:offset={round(i*(D-0.4),2)}[v{i}]"); prev=f"v{i}"
    final=f"{out}/{name}.mp4"
    subprocess.run(['ffmpeg','-y','-loglevel','error',*args,'-filter_complex',';'.join(F),'-map',f'[{prev}]','-map',f'{len(clips)}:a','-shortest','-c:v','libx264','-preset','medium','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',final],check=True)
    ims=[Image.open(f).resize((216,384)) for f in files]
    cs=Image.new('RGB',(216*len(ims),384)); [cs.paste(im,(216*i,0)) for i,im in enumerate(ims)]; cs.save(f"{out}/{name}_sheet.jpg")
    for f in files+clips: os.remove(f)
    print(final)
if __name__=='__main__': build(sys.argv[1])
