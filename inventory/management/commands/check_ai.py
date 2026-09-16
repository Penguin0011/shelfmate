import base64
import io
from PIL import Image, ImageDraw
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from inventory.ai import request, AIError, suggestions, complete
from inventory.validation import entries, Invalid

class Command(BaseCommand):
    help = 'Opt-in live AI check using a generated, non-sensitive label image'
    def add_arguments(self, parser):
        parser.add_argument('--provider', choices=['gemini','nvidia','openrouter','auto'], required=True)
    def handle(self, provider, **options):
        image=Image.new('RGB',(640,320),'white')
        ImageDraw.Draw(image).text((30,100),'M3 SCREWS - 16 mm',fill='black',font_size=36)
        stream=io.BytesIO()
        image.save(stream,format='JPEG')
        content=[{'type':'text','text':'Read the label. Return ONLY a JSON array of objects with name, description, aliases as strings. Do not infer quantities.'},{'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+base64.b64encode(stream.getvalue()).decode()}}]
        if provider=='gemini':
            args=('Gemini',settings.GEMINI_API_KEY,settings.GEMINI_MODEL,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
        elif provider=='nvidia':
            args=('NVIDIA',settings.NVIDIA_API_KEY,settings.NVIDIA_MODEL,'https://integrate.api.nvidia.com/v1/chat/completions')
        else:
            args=('OpenRouter',settings.OPENROUTER_API_KEY,settings.OPENROUTER_MODEL,'https://openrouter.ai/api/v1/chat/completions')
        try:
            if provider == 'auto':
                parsed=complete([{'role':'user','content':content}], suggestions)
                model='automatic failover'
            else:
                result, model=request(*args,[{'role':'user','content':content}])
                parsed=suggestions(result)
        except (AIError, Invalid) as exc:
            raise CommandError(str(exc)) from None
        self.stdout.write(f'{provider}: valid response; model={model}; entries={len(parsed)}')
