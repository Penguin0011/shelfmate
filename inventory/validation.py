class Invalid(ValueError):
    pass


def string(data, key, maximum, required=False):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise Invalid(f'Invalid {key}')
    return value.strip()


def integer(data, key):
    value = data.get(key)
    if type(value) is not int or value < 0:
        raise Invalid(f'Invalid {key}')
    return value


def entries(value):
    if not isinstance(value, list) or len(value) > 100:
        raise Invalid('Expected at most 100 items')
    result = []
    for row in value:
        if not isinstance(row, dict):
            raise Invalid('Invalid item')
        result.append({'name': string(row, 'name', 200, True), 'description': string(row, 'description', 2000), 'aliases': string(row, 'aliases', 1000)})
    return result
