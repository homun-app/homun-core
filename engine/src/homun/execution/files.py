"""Bounded file IO anchored to an owned workspace directory descriptor."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import secrets
import stat
from homun.domain.errors import PermissionDeniedError, ValidationError

MAX_BYTES=25*1024*1024
MAX_DIRECTORY_SCAN=5000


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

    def list_page(self,path='',*,limit=100,cursor=''):
        """Sorted page of one directory. A scan cap is not a continuable cursor."""
        if not 1<=limit<=200:raise ValidationError('Invalid listing limit')
        if cursor and (len(cursor)>255 or '/' in cursor or cursor in {'.','..'}):
            raise ValidationError('Invalid listing cursor')
        collected=[];scan_limited=False
        with self._open(path,directory=True) as fd:
            with os.scandir(fd) as entries:
                for entry in entries:
                    if entry.name.startswith('.homun-edit-'):continue
                    if len(collected)>=MAX_DIRECTORY_SCAN:scan_limited=True;break
                    try:info=entry.stat(follow_symlinks=False)
                    except OSError:continue
                    kind='directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) and info.st_nlink==1 else None
                    if kind:collected.append({'name':entry.name,'kind':kind,'byte_size':info.st_size if kind=='file' else None})
        collected.sort(key=lambda item:item['name'])
        if scan_limited:
            return {'path':path,'items':collected[:limit],'truncated':True,'scan_limited':True}
        start=0
        if cursor:
            start=next((index+1 for index,item in enumerate(collected) if item['name']==cursor),None)
            if start is None:raise ValidationError('Listing cursor is not in this directory')
        page=collected[start:start+limit]
        truncated=start+limit<len(collected)
        result={'path':path,'items':page,'truncated':truncated,'scan_limited':False}
        if truncated and page:result['next_cursor']=page[-1]['name']
        return result

    def write_bytes(self,path,data,*,before_sha):
        """Replace regular file bytes once. Returns written, already, mismatch or uncertain."""
        if not isinstance(data,(bytes,bytearray)) or len(data)>MAX_BYTES:
            raise ValidationError('Invalid workspace write')
        data=bytes(data)
        after=hashlib.sha256(data).hexdigest()
        parts=_parts(path)
        name=parts[-1]
        if name.startswith('.homun-edit-'):
            raise PermissionDeniedError('Reserved workspace name')
        parent='/'.join(parts[:-1])
        try:
            current=self.read(path)
        except ValidationError as exc:
            if exc.message!='Workspace file is unavailable':raise
            current=None
        current_sha=hashlib.sha256(current).hexdigest() if current is not None else None
        if current is not None and current==data:return 'already'
        if current_sha!=before_sha:return 'mismatch'
        self._replace(parent,name,data)
        try:
            verified=self.read(path)
        except (ValidationError,PermissionDeniedError):
            return 'uncertain'
        return 'written' if verified==data and hashlib.sha256(verified).hexdigest()==after else 'uncertain'

    def _replace(self,parent,name,data):
        temporary=f'.homun-edit-{secrets.token_hex(8)}'
        with self._open(parent,directory=True) as fd:
            info=None
            try:info=os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:info=None
            if info is not None and (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink!=1):
                raise PermissionDeniedError('Only a regular workspace file without links can be replaced')
            out=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)
            try:
                view=memoryview(data)
                while view:
                    written=os.write(out,view)
                    if written<=0:raise ValidationError('Workspace write was interrupted')
                    view=view[written:]
                os.fsync(out)
            except Exception:
                os.close(out)
                os.unlink(temporary,dir_fd=fd)
                raise
            os.close(out)
            try:
                os.rename(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)
            except Exception:
                os.unlink(temporary,dir_fd=fd)
                raise
            os.fsync(fd)
