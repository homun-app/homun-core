"""Bounded local BM25 catalog search.

"""
from collections import Counter
import math
import re


def tokens(text):
    return re.findall(r'[^\W_]+', text.casefold())


def ranked(entries, query, limit):
    terms = list(dict.fromkeys(tokens(query)))
    if not terms or not entries or limit <= 0:
        return []
    documents = [tokens(' '.join((e['name'], e['toolset'], e['description'],
        ' '.join(e['input_schema'].get('properties', {}))))) for e in entries]
    counts = [Counter(document) for document in documents]
    frequencies = Counter(term for count in counts for term in count)
    gate = min(terms, key=lambda term: frequencies[term])
    answerable = {term for term in terms if frequencies[term]}
    required = math.ceil(len(answerable) / 2) if len(answerable) >= 4 else 1
    average = max(sum(map(len, documents)) / len(documents), 1)
    scored = []
    for entry, document, count in zip(entries, documents, counts):
        exact = entry['name'].casefold() == query.strip().casefold()
        if not exact and (gate not in count or len(answerable.intersection(count)) < required):
            continue
        score = 0
        for term in terms:
            frequency = frequencies[term]
            occurrences = count[term]
            if occurrences:
                idf = math.log(1 + (len(entries) - frequency + .5) / (frequency + .5))
                score += idf * occurrences * 2.5 / (occurrences + 1.5 * (.25 + .75 * len(document) / average))
        scored.append((not exact, -score, entry['name'], entry))
    return [item[3] for item in sorted(scored, key=lambda item: item[:3])[:limit]]
