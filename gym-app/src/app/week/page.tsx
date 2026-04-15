import { redirect } from 'next/navigation';

export default function WeekRedirect() {
  redirect('/calendar?view=week');
}
