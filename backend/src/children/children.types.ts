import {
  AnalysisPreferences,
  ChildAgeGroup,
  ChildProfileStatus,
  RetentionPreferences,
} from './schemas/child-profile.schema';

export interface ChildProfileResponse {
  ageGroup: ChildAgeGroup;
  analysisPreferences: AnalysisPreferences;
  createdAt: string;
  id: string;
  languages: string[];
  name: string;
  nickname?: string;
  profileImageUrl?: string;
  retentionPreferences: RetentionPreferences;
  status: ChildProfileStatus;
  updatedAt: string;
}

export interface ChildProfileEnvelope {
  data: ChildProfileResponse;
  success: true;
}

export interface ChildProfilePageEnvelope {
  data: ChildProfileResponse[];
  meta: {
    nextCursor?: string;
  };
  success: true;
}
