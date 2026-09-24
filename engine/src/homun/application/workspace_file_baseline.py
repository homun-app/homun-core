"""Read coverage required before a workspace file can be replaced."""


def _records(run):
    found = []
    for observation in run.get('observations', []):
        result = observation.get('result') if isinstance(observation, dict) else None
        coverage = result.get('file_coverage') if isinstance(result, dict) else None
        if isinstance(coverage, dict):
            found.append(coverage)
    return found


def full_baseline(run, path, sha):
    """True when this run has seen every current UTF-8 line, or the whole character file."""
    ranges, total = [], None
    for item in _records(run):
        if item.get('path') != path or item.get('sha256') != sha or item.get('representation') != 'utf-8':
            continue
        if item.get('complete'):
            return True
        if item.get('total_lines') == 0:
            return True
        if item.get('line_start') and item.get('line_end') and item.get('total_lines') is not None:
            ranges.append((int(item['line_start']), int(item['line_end'])))
            total = int(item['total_lines'])
    if total is None:
        return False
    covered = set()
    for start, end in ranges:
        covered.update(range(start, end + 1))
    return set(range(1, total + 1)) <= covered


def seen_current(run, path, sha):
    """True when a UTF-8 line page or a complete character read matches the current hash."""
    if full_baseline(run, path, sha):
        return True
    return any(item.get('path') == path and item.get('sha256') == sha and item.get('representation') == 'utf-8'
               and item.get('line_start') for item in _records(run))
