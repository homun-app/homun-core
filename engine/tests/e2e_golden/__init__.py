"""Banco di prova end-to-end del percorso d'oro (marcatore ``golden``).

Suite separata da quella normale: usa modelli veri, avvia il motore come
processo reale e misura tassi di successo su N ripetizioni. Si lancia solo
esplicitamente::

    cd engine && HOMUN_GOLDEN_PROVIDER=local .venv/bin/pytest -m golden -q

ed è esclusa dalla suite normale e dalla CI tramite ``-m "not golden"``
in ``engine/pyproject.toml``.
"""
