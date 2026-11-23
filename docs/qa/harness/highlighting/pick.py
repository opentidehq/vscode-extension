import sys, os, json, hashlib
from PIL import Image, ImageChops
out = '/tmp/qa/hl/out'; dst = '/home/user/vscode-extension/docs/qa/screens'
box = (400, 540, 1300, 720)
res = {}
for kind in ('kql', 'esql'):
  for theme in ('dark', 'light'):
    d = f'{out}/frames-shots-{kind}-{theme}-on-1'
    n = len([f for f in os.listdir(d) if f.endswith('.png')])
    crops = []
    for k in range(n):
      im = Image.open(f'{d}/{k}.png').convert('RGB'); crops.append(im.crop(box))
    last = crops[-1]
    # earliest index from which every later frame has the same query crop as the last one
    i = n - 1
    while i > 0 and ImageChops.difference(crops[i-1], last).getbbox() is None: i -= 1
    after = i
    # before: last frame before `after` whose crop differs from the final one and which already has the grammar colours (crop != first crop)
    before = after - 1
    full_b = Image.open(f'{d}/{before}.png').convert('RGB'); full_a = Image.open(f'{d}/{after}.png').convert('RGB')
    diff = ImageChops.difference(full_b, full_a); bb = diff.getbbox()
    # changed pixels outside the query crop
    mask = Image.new('L', full_b.size, 255); mask.paste(0, box); outside = ImageChops.difference(full_b, full_a).convert('L'); outside = Image.composite(outside, Image.new('L', outside.size, 0), mask).getbbox()
    res[f'{kind}-{theme}'] = dict(frames=n, before=before, after=after, diff_bbox=bb, outside_query_bbox=outside)
    name = f'hl-{kind}-{theme}'
    full_b.save(f'{dst}/{name}-1-before-semantic.png'); full_a.save(f'{dst}/{name}-2-after-semantic.png')
    # side by side zoom of the query block
    w, h = box[2]-box[0], box[3]-box[1]
    zb = full_b.crop(box).resize((w*2//1, h*2//1)); za = full_a.crop(box).resize((w*2//1, h*2//1))
    canvas = Image.new('RGB', (zb.width, zb.height*2 + 6), (128, 128, 128)); canvas.paste(zb, (0, 0)); canvas.paste(za, (0, zb.height + 6)); canvas.save(f'{dst}/{name}-3-query-before-over-after.png')
print(json.dumps(res, indent=1))
