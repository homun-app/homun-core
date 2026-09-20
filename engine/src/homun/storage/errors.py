"""Storage failure boundary used by transport error handlers."""
from sqlite3 import Error as StorageError

__all__ = ['StorageError']
