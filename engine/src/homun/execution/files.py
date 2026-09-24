"""Bounded file IO anchored to an owned workspace directory descriptor."""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError

MAX_BYTES=25*1024*1024


class FileChangedError(ValidationError):
    code='workspace_file_changed'



def _parts(path,*,directory=False):
    if directory and path=='':return []
    if (not isinstance(path,str) or not path or len(path)>1024 or '\\' in path
            or '\x00' in path or any(p in {'','..','.'} for p in path.split('/'))):
        raise PermissionDeniedError('Use a relative workspace path without traversal')
    return path.split('/')


class WorkspaceFiles:
    def __init__(self,root: Path):self.root=Path(root)

    @contextmanager
    def _open(self,path,*,directory=False):
        parts=_parts(path,directory=directory)
        fds=[]
        try:
            if self.root.is_symlink() or any(p.is_symlink() for p in self.root.parents):
                raise PermissionDeniedError('Workspace root must not contain symlinks')
            fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(fd)
            for i,part in enumerate(parts):
                flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
                if directory or i<len(parts)-1:flags|=os.O_DIRECTORY
                fd=os.open(part,flags,dir_fd=fd);fds.append(fd)
            yield fd
        except FileNotFoundError:
            raise ValidationError('Workspace file is unavailable') from None
        except OSError:
            raise PermissionDeniedError('Workspace path cannot be accessed safely') from None
        finally:
            for fd in reversed(fds):os.close(fd)

    def read(self,path,*,max_bytes=MAX_BYTES):
        if not 1<=max_bytes<=MAX_BYTES:raise ValidationError('Invalid file size limit')
        with self._open(path) as fd:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1:
                raise PermissionDeniedError('Only regular workspace files without hardlinks can be read')
            if before.st_size>max_bytes:raise ValidationError('Workspace file exceeds the size limit')
            data=bytearray()
            while len(data)<=max_bytes:
                chunk=os.read(fd,min(65536,max_bytes+1-len(data)))
                if not chunk:break
                data.extend(chunk)
            after=os.fstat(fd)
            if len(data)>max_bytes:raise ValidationError('Workspace file exceeds the size limit')
            attributes=('st_ino','st_dev','st_size','st_mtime_ns','st_ctime_ns','st_nlink')
            if any(getattr(before,k)!=getattr(after,k) for k in attributes) or len(data)!=after.st_size:
                raise FileChangedError('Workspace file changed during reading; read it again')
            return bytes(data)

    def list(self,path='',*,limit=100):
        if not 1<=limit<=200:raise ValidationError('Invalid listing limit')
        items=[];truncated=False
        with self._open(path,directory=True) as fd:
            with os.scandir(fd) as entries:
                for index,entry in enumerate(entries):
                    if index>=limit:truncated=True;break
                    info=entry.stat(follow_symlinks=False)
                    kind='directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) and info.st_nlink==1 else None
                    if kind:items.append({'name':entry.name,'kind':kind,'byte_size':info.st_size if kind=='file' else None})
        return {'path':path,'items':sorted(items,key=lambda i:i['name']),'truncated':truncated}
