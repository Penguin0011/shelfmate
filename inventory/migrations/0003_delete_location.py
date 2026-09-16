from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [('inventory', '0002_location_box_location')]
    operations = [migrations.DeleteModel(name='Location')]
