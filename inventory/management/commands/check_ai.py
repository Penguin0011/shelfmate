import base64
import io
from PIL import Image, ImageDraw
from django.core.management.base import BaseCommand, CommandError
from inventory.ai import request, AIError, suggestions, complete, providers
from inventory.validation import Invalid

class Command(BaseCommand):
    help = 'Opt-in live AI check using a generated, non-sensitive label image'
    def add_arguments(self, parser):
        parser.add_argument('--provider', choices=['fireworks','gemini','openrouter','auto'], required=True)
    def handle(self, provider, **options):
        image=Image.new('RGB',(640,320),'white')
        ImageDraw.Draw(image).text((30,100),'M3 SCREWS - 16 mm',fill='black',font_size=36)
        stream=io.BytesIO()
        image.save(stream,format='JPEG')
        content=[{'type':'text','text':'Read the label. Return ONLY a JSON array of objects with name, description, aliases as strings. Do not infer quantities.'},{'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+base64.b64encode(stream.getvalue()).decode()}}]
        try:
            if provider == 'auto':
                parsed=complete([{'role':'user','content':content}], suggestions)
                model='automatic failover'
            else:
                name, key, configured_model, url, extra = next(p for p in providers() if p[0].lower() == provider)
                result, model=request(name, key, configured_model, url,[{'role':'user','content':content}],extra=extra)
                parsed=suggestions(result)
        except (AIError, Invalid) as exc:
            raise CommandError(str(exc)) from None
        self.stdout.write(f'{provider}: valid response; model={model}; entries={len(parsed)}')
