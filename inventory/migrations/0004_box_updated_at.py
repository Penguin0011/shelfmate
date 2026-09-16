import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('inventory', '0003_delete_location')]

    operations = [
        migrations.AddField(
            model_name='box',
            name='updated_at',
            field=models.DateTimeField(auto_now=True, default=django.utils.timezone.now),
            preserve_default=False,
        ),
    ]
