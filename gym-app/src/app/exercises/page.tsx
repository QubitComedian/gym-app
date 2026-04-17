import { redirect } from 'next/navigation';

// Old /exercises top-level route forwards into the new training subpage
// where the exercise library now lives.
export default function ExercisesRedirect() {
  redirect('/you/training');
}
