import { Button } from "@src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@src/components/ui/dialog";
import { Input } from "@src/components/ui/input";
import { Eye, EyeOff, Lock, RefreshCw } from "lucide-react";

export type PrivateAccessMode = "unlock" | "setup" | "recovery";

type PrivateSpaceAccessDialogProps = {
  open: boolean;
  loading: boolean;
  mode: PrivateAccessMode;
  error: string | null;
  showPassword: boolean;
  requiresPassword: boolean;
  hasRecovery: boolean;
  recoveryQuestions: string[];
  password: string;
  confirmPassword: string;
  question1: string;
  question2: string;
  answer1: string;
  answer2: string;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: PrivateAccessMode) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onQuestion1Change: (value: string) => void;
  onQuestion2Change: (value: string) => void;
  onAnswer1Change: (value: string) => void;
  onAnswer2Change: (value: string) => void;
  onShowPasswordChange: (show: boolean) => void;
  onReset: () => void;
  onClearCredentials: () => void;
  onShuffleQuestions: () => void;
  onSubmit: () => Promise<void>;
};

const TITLES: Record<PrivateAccessMode, string> = {
  setup: "Lock your private space",
  recovery: "Reset your password",
  unlock: "Private space",
};

const DESCRIPTIONS: Record<PrivateAccessMode, string> = {
  setup: "Set a password to keep these folders and tabs hidden on this device.",
  recovery: "Answer your recovery questions to set a new password.",
  unlock: "Enter your password to view private folders and tabs.",
};

const SUBMIT_LABELS: Record<PrivateAccessMode, string> = {
  setup: "Save and unlock",
  recovery: "Recover and unlock",
  unlock: "Unlock",
};

export function PrivateSpaceAccessDialog({
  open,
  loading,
  mode,
  error,
  showPassword,
  requiresPassword,
  hasRecovery,
  recoveryQuestions,
  password,
  confirmPassword,
  question1,
  question2,
  answer1,
  answer2,
  onOpenChange,
  onModeChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onQuestion1Change,
  onQuestion2Change,
  onAnswer1Change,
  onAnswer2Change,
  onShowPasswordChange,
  onReset,
  onClearCredentials,
  onShuffleQuestions,
  onSubmit,
}: PrivateSpaceAccessDialogProps) {
  const handleOpenChange = (nextOpen: boolean): void => {
    if (loading) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      onModeChange(requiresPassword ? "setup" : "unlock");
      onReset();
    }
  };

  const switchMode = (nextMode: PrivateAccessMode): void => {
    onModeChange(nextMode);
    onClearCredentials();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex w-full max-w-lg flex-col gap-5 rounded-2xl p-6 sm:max-w-lg">
        <DialogHeader>
          <div className="mb-1.5 flex size-12 items-center justify-center rounded-xl bg-foreground-neutral text-background-neutral shadow-sm">
            <Lock size={20} />
          </div>
          <DialogTitle className="font-sans-bold text-xl tracking-[-0.01em] text-foreground-neutral">
            {TITLES[mode]}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-foreground-secondary">
            {DESCRIPTIONS[mode]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {(mode === "unlock" || mode === "setup") && (
            <div className="space-y-1.5">
              <label
                htmlFor="private-password"
                className="text-[13px] font-medium text-foreground-neutral"
              >
                {mode === "setup" ? "Create a password" : "Password"}
              </label>
              <div className="relative">
                <Input
                  id="private-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  placeholder={
                    mode === "setup"
                      ? "At least 8 characters"
                      : "Enter your password"
                  }
                  autoFocus
                  className="pr-10"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void onSubmit();
                  }}
                />
                <button
                  type="button"
                  onClick={() => onShowPasswordChange(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-foreground-tertiary outline-none transition-colors hover:text-foreground-neutral"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          )}

          {(mode === "setup" || mode === "recovery") && (
            <div className="space-y-1.5">
              <label
                htmlFor="private-confirm"
                className="text-[13px] font-medium text-foreground-neutral"
              >
                {mode === "setup" ? "Confirm password" : "Confirm new password"}
              </label>
              <Input
                id="private-confirm"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) =>
                  onConfirmPasswordChange(event.target.value)
                }
                placeholder="Re-enter password"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSubmit();
                }}
              />
            </div>
          )}

          {mode === "setup" && (
            <div className="space-y-3 border-t border-border-neutral-faded pt-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
                  Recovery questions
                </p>
                <p className="mt-0.5 text-xs text-foreground-secondary">
                  The only way back in if you forget your password.
                </p>
              </div>
              <RecoveryQuestionFields
                number={1}
                question={question1}
                answer={answer1}
                onQuestionChange={onQuestion1Change}
                onAnswerChange={onAnswer1Change}
              />
              <RecoveryQuestionFields
                number={2}
                question={question2}
                answer={answer2}
                onQuestionChange={onQuestion2Change}
                onAnswerChange={onAnswer2Change}
              />
              <button
                type="button"
                onClick={onShuffleQuestions}
                className="mx-auto flex w-fit items-center gap-1.5 rounded-md border border-border-neutral-faded px-2.5 py-1.5 text-xs font-medium text-foreground-secondary outline-none transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
              >
                <RefreshCw size={12} />
                Shuffle questions
              </button>
            </div>
          )}

          {mode === "recovery" && (
            <RecoveryFields
              questions={recoveryQuestions}
              answer1={answer1}
              answer2={answer2}
              password={password}
              onAnswer1Change={onAnswer1Change}
              onAnswer2Change={onAnswer2Change}
              onPasswordChange={onPasswordChange}
              onSubmit={onSubmit}
            />
          )}

          {error && <p className="text-xs text-foreground-danger">{error}</p>}
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            {mode === "unlock" && hasRecovery && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => switchMode("recovery")}
                disabled={loading}
              >
                Forgot password?
              </Button>
            )}
            {mode === "recovery" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => switchMode("unlock")}
                disabled={loading}
              >
                Use password instead
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void onSubmit()}
              disabled={loading}
            >
              {loading ? "Please wait..." : SUBMIT_LABELS[mode]}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type RecoveryQuestionFieldsProps = {
  number: number;
  question: string;
  answer: string;
  onQuestionChange: (value: string) => void;
  onAnswerChange: (value: string) => void;
};

function RecoveryQuestionFields({
  number,
  question,
  answer,
  onQuestionChange,
  onAnswerChange,
}: RecoveryQuestionFieldsProps) {
  return (
    <div className="flex gap-3">
      <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-full bg-foreground-neutral text-[11px] font-semibold text-background-neutral">
        {number}
      </span>
      <div className="flex-1 space-y-2">
        <Input
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          placeholder="Security question"
        />
        <Input
          value={answer}
          onChange={(event) => onAnswerChange(event.target.value)}
          placeholder="Answer"
        />
      </div>
    </div>
  );
}

type RecoveryFieldsProps = {
  questions: string[];
  answer1: string;
  answer2: string;
  password: string;
  onAnswer1Change: (value: string) => void;
  onAnswer2Change: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => Promise<void>;
};

function RecoveryFields({
  questions,
  answer1,
  answer2,
  password,
  onAnswer1Change,
  onAnswer2Change,
  onPasswordChange,
  onSubmit,
}: RecoveryFieldsProps) {
  return (
    <>
      <RecoveryQuestionLabel number={1} question={questions[0]} />
      <Input
        value={answer1}
        onChange={(event) => onAnswer1Change(event.target.value)}
        placeholder="Answer 1"
        autoFocus
      />
      <RecoveryQuestionLabel number={2} question={questions[1]} />
      <Input
        value={answer2}
        onChange={(event) => onAnswer2Change(event.target.value)}
        placeholder="Answer 2"
      />
      <Input
        type="password"
        value={password}
        onChange={(event) => onPasswordChange(event.target.value)}
        placeholder="New password"
        onKeyDown={(event) => {
          if (event.key === "Enter") void onSubmit();
        }}
      />
    </>
  );
}

function RecoveryQuestionLabel({
  number,
  question,
}: {
  number: number;
  question?: string;
}) {
  return (
    <div className="rounded-lg border border-border-neutral-faded bg-background-neutral/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.08em] text-foreground-tertiary">
        Recovery question {number}
      </p>
      <p className="mt-0.5 text-sm text-foreground-secondary">
        {question || "Question unavailable"}
      </p>
    </div>
  );
}
