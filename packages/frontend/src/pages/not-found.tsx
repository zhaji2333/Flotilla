import { ArrowLeft, Compass } from 'lucide-react';
import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-[900px] flex-col items-start justify-center">
      <Compass className="size-8 text-lime" aria-hidden="true" />
      <p className="display mt-6 text-[clamp(3rem,10vw,7rem)] text-paper">404</p>
      <h1 className="display mt-2 text-[13px] tracking-[0.2em] text-muted">SIGNAL NOT FOUND</h1>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
        这个坐标没有对应的投影。前端路由只覆盖项目、轨迹、发现、审批与拦截记录。
      </p>
      <Link to="/" className="btn btn-primary mt-6">
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        返回总览
      </Link>
    </div>
  );
}
